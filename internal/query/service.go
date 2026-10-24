package query

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"datasource_service/internal/config"
	"datasource_service/internal/model"
	"datasource_service/internal/repo"
)

// 日志里 SQL 的上限。mid_sql 最长 1 MiB，全量打进日志会把日志撑爆，
// 排查时通常也只需要看外层的 SELECT / WHERE / GROUP BY 部分。
const maxLoggedSQL = 2000

func loggableSQL(sqlText string) string {
	if len(sqlText) <= maxLoggedSQL {
		return sqlText
	}
	return sqlText[:maxLoggedSQL] + fmt.Sprintf(" ...(已截断，共 %d 字节)", len(sqlText))
}

// formatParams 把绑定参数拼成 p0=北京, rf0=[t1 t2] 这样的形式。
// SQL 里是 {p0:String} 这样的命名占位符，光看 SQL 文本不知道实际传了什么，
// 排查「为什么没数据」时参数往往比 SQL 本身更有用。
func formatParams(params []Param) string {
	if len(params) == 0 {
		return ""
	}
	parts := make([]string, 0, len(params))
	for _, p := range params {
		parts = append(parts, fmt.Sprintf("%s=%v", p.Name, p.Value))
	}
	return strings.Join(parts, ", ")
}

// Service 查询业务层：取配置 → 组装 SQL → 执行 → 记日志。
type Service struct {
	repo    *repo.DatasourceRepo
	engine  Engine
	cfg     config.QueryConfig
	timeout time.Duration
	sem     chan struct{} // 并发闸门
}

// NewService 构造查询服务。
func NewService(r *repo.DatasourceRepo, e Engine, cfg config.QueryConfig, timeout time.Duration) *Service {
	return &Service{
		repo:    r,
		engine:  e,
		cfg:     cfg,
		timeout: timeout,
		sem:     make(chan struct{}, cfg.MaxConcurrency),
	}
}

// ErrForbidden 表示当前登录态的租户看不到该数据源。handler 映射为 403。
var ErrForbidden = errors.New("forbidden")

// VisibleDatasources 返回当前登录态可见的数据源。
//
// 可见性规则：数据源的租户白名单为空 = 不限制（所有租户可见）；
// 非空 = 登录态租户与白名单有交集才可见。
func (s *Service) VisibleDatasources(ctx context.Context, tenants []string) ([]QueryDatasource, error) {
	items, err := s.repo.ListAvailable(ctx, 0)
	if err != nil {
		return nil, err
	}
	out := make([]QueryDatasource, 0, len(items))
	for _, it := range items {
		if !it.ACL.Allows(tenants) {
			continue
		}
		dims := filterColumns(it.DimMap, it.ACL, tenants)
		mtxs := filterColumns(it.MtxMap, it.ACL, tenants)
		out = append(out, QueryDatasource{
			DatasourceKey:  it.DatasourceKey,
			DatasourceName: it.DatasourceName,
			DimMap:         dims,
			MtxMap:         mtxs,
			// label_map 只保留还看得见的列，避免表头里出现用不到的中文名
			LabelMap: filterColumns(it.LabelMap, it.ACL, tenants),
		})
	}
	return out, nil
}

// filterColumns 按列级白名单过滤。键名就是维度/指标名，与 label_map 的键一致。
func filterColumns(m map[string]string, acl model.ACL, tenants []string) map[string]string {
	out := make(map[string]string, len(m))
	for k, v := range m {
		if !acl.AllowsColumn(k, tenants) {
			continue
		}
		out[k] = v
	}
	return out
}

// buildRowFilters 根据数据源配置与登录态合成行级权限条件。
//
// 列表达式只从服务端持有的 dim_map 里取，绝不采信客户端传入的文本。
// 开启但登录态列表为空时保留空 Values：IN () 不匹配任何行，等价于拒绝——
// 权限配置宁可看不到，也不能看到别人的数据。
func buildRowFilters(ds *model.DatasourceConfig, tenants, users []string) []RowFilter {
	rf := ds.ACL.RowFilter
	var out []RowFilter
	if rf.Tenant.Enabled {
		out = append(out, RowFilter{Expr: ds.DimMap[rf.Tenant.Column], Values: tenants})
	}
	if rf.User.Enabled {
		out = append(out, RowFilter{Expr: ds.DimMap[rf.User.Column], Values: users})
	}
	return out
}

// ensureColumnsVisible 校验请求里引用的列对当前登录态是否都可见。
// 前端下拉已经过滤过，但请求本身可以被直接构造，所以服务端必须再挡一次。
func ensureColumnsVisible(acl model.ACL, tenants []string, cols ...string) error {
	for _, c := range cols {
		if c == "" {
			continue
		}
		if !acl.AllowsColumn(c, tenants) {
			return fmt.Errorf("%w: 当前登录态的租户无权访问列 %q", ErrForbidden, c)
		}
	}
	return nil
}

// Execute 执行一次查询。
func (s *Service) Execute(ctx context.Context, req *ExecuteRequest, operator string, tenants, users []string) (*ExecuteResult, error) {
	ds, err := s.repo.GetByKey(ctx, req.DatasourceKey)
	if err != nil {
		return nil, err
	}
	if !ds.ACL.Allows(tenants) {
		slog.Warn("query denied by tenant acl",
			"operator", operator, "datasource_key", ds.DatasourceKey,
			"tenants", tenants, "acl_tenants", ds.ACL.Tenants,
		)
		return nil, fmt.Errorf("%w: 当前登录态的租户无权访问数据源 %q", ErrForbidden, ds.DatasourceKey)
	}
	// 列级管控：维度、指标，以及过滤条件里引用到的字段都要校验。
	// 过滤条件尤其容易漏——它可以引用没被选为维度的列。
	if err := ensureColumnsVisible(ds.ACL, tenants, req.Dims...); err != nil {
		return nil, err
	}
	if err := ensureColumnsVisible(ds.ACL, tenants, req.Metrics...); err != nil {
		return nil, err
	}
	if err := ensureColumnsVisible(ds.ACL, tenants, FilterNodeFields(req.Filter)...); err != nil {
		return nil, err
	}

	// mid_sql 可能是模板：按本次用到的字段决定保留哪些 JOIN。
	// 行级权限用到的列也要算进来，否则模板可能裁掉权限条件依赖的 JOIN。
	rfSpec := RowFilterSpec{
		TenantColumn: ds.ACL.RowFilter.Tenant.Column,
		UserColumn:   ds.ACL.RowFilter.User.Column,
	}
	filterFields := FilterNodeFields(req.Filter)
	midSQL, err := RenderMidSQL(ds.MidSQL, MidSQLData{
		Dims:    req.Dims,
		Metrics: req.Metrics,
		Fields:  buildFields(req.Dims, req.Metrics, filterFields, rowFilterColumns(rfSpec)),
		Filters: dedupSorted(filterFields),
	})
	if err != nil {
		return nil, err
	}

	sqlText, params, err := Build(Spec{
		DatasourceKey: ds.DatasourceKey,
		MidSQL:        midSQL,
		DimMap:        ds.DimMap,
		MtxMap:        ds.MtxMap,
		Dims:          req.Dims,
		Metrics:       req.Metrics,
		Filter:        req.Filter,
		RowFilters:    buildRowFilters(ds, tenants, users),
		OrderBy:       req.OrderBy,
		Limit:         req.Limit,
		MaxLimit:      s.cfg.MaxResultRows,
		DefaultLimit:  s.cfg.DefaultLimit,
	})
	if err != nil {
		return nil, err
	}

	// 并发闸门：同步模式下没人管的话，几个人各点几个大查询就能把 CH 拖垮。
	select {
	case s.sem <- struct{}{}:
		defer func() { <-s.sem }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}

	start := time.Now()
	queryCtx, cancel := context.WithTimeout(ctx, s.timeout)
	defer cancel()

	res, err := s.engine.Query(queryCtx, sqlText, params)
	elapsed := time.Since(start).Milliseconds()

	if err != nil {
		// SQL 只进日志，不回给前端——用户不感知 SQL，出错时拿 request_id 来查。
		slog.Error("query failed",
			"operator", operator, "datasource_key", ds.DatasourceKey,
			"dims", req.Dims, "metrics", req.Metrics,
			"elapsed_ms", elapsed, "error", err,
			"sql", loggableSQL(sqlText), "params", formatParams(params),
		)
		return nil, err
	}

	res.ElapsedMs = elapsed
	// 成功也把 SQL 打出来：日常排查「这个数是怎么算出来的」主要靠这条日志，
	// 行级权限注入的条件也只在这里能看到全貌。
	slog.Info("query executed",
		"operator", operator, "datasource_key", ds.DatasourceKey,
		"dims", req.Dims, "metrics", req.Metrics, "filters", FilterNodeCount(req.Filter),
		"rows", res.RowCount, "truncated", res.Truncated, "elapsed_ms", elapsed,
		"sql", loggableSQL(sqlText), "params", formatParams(params),
	)
	return res, nil
}

// DimValues 返回某个维度的候选值，供前端下拉枚举。
func (s *Service) DimValues(ctx context.Context, datasourceKey, field string, tenants, users []string) ([]string, error) {
	ds, err := s.repo.GetByKey(ctx, datasourceKey)
	if err != nil {
		return nil, err
	}
	if !ds.ACL.Allows(tenants) {
		return nil, fmt.Errorf("%w: 当前登录态的租户无权访问数据源 %q", ErrForbidden, datasourceKey)
	}
	if !ds.ACL.AllowsColumn(field, tenants) {
		return nil, fmt.Errorf("%w: 当前登录态的租户无权访问列 %q", ErrForbidden, field)
	}
	expr, ok := ds.DimMap[field]
	if !ok {
		return nil, fmt.Errorf("%w: 字段 %q 不是该数据源的维度", ErrInvalidQuery, field)
	}

	// 候选值查询只用到一个维度列，但行级权限的列也要参与渲染判断
	rfSpec := RowFilterSpec{
		TenantColumn: ds.ACL.RowFilter.Tenant.Column,
		UserColumn:   ds.ACL.RowFilter.User.Column,
	}
	midSQL, err := RenderMidSQL(ds.MidSQL, MidSQLData{
		Dims:   []string{field},
		Fields: buildFields([]string{field}, nil, nil, rowFilterColumns(rfSpec)),
	})
	if err != nil {
		return nil, err
	}
	sqlText, params := BuildDimValuesSQL(midSQL, expr, s.cfg.DimValueLimit, buildRowFilters(ds, tenants, users))

	select {
	case s.sem <- struct{}{}:
		defer func() { <-s.sem }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}

	queryCtx, cancel := context.WithTimeout(ctx, s.timeout)
	defer cancel()

	res, err := s.engine.Query(queryCtx, sqlText, params)
	if err != nil {
		slog.Error("dim values query failed", "datasource_key", datasourceKey, "field", field,
			"error", err, "sql", loggableSQL(sqlText), "params", formatParams(params))
		return nil, err
	}
	slog.Info("dim values query executed", "datasource_key", datasourceKey, "field", field,
		"rows", len(res.Rows), "sql", loggableSQL(sqlText), "params", formatParams(params))

	values := make([]string, 0, len(res.Rows))
	for _, row := range res.Rows {
		if len(row) == 0 || row[0] == nil {
			continue
		}
		values = append(values, fmt.Sprint(row[0]))
	}
	return values, nil
}
