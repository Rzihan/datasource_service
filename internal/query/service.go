package query

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"dataset_service/internal/config"
	"dataset_service/internal/model"
	"dataset_service/internal/repo"
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

// LabelProvider 提供全局字段名称字典（field_key → 中文名）。
//
// 定义成接口而不是直接依赖 service.LabelService：query 包只用到「查字典」这一个能力，
// 用接口把它隔离开，避免查询链路顺带依赖上数据集 CRUD 的一整套规则。
// 实现侧带进程内缓存，这里可以放心地每次调用。
type LabelProvider interface {
	Map(ctx context.Context) map[string]string
}

// Service 查询业务层：取配置 → 组装 SQL → 执行 → 记日志。
type Service struct {
	repo    *repo.DatasetRepo
	engine  Engine
	labels  LabelProvider
	cfg     config.QueryConfig
	timeout time.Duration
	sem     chan struct{} // 并发闸门
}

// NewService 构造查询服务。labels 可为 nil，此时只使用数据集自己的 label_map。
func NewService(r *repo.DatasetRepo, e Engine, labels LabelProvider, cfg config.QueryConfig, timeout time.Duration) *Service {
	return &Service{
		repo:    r,
		engine:  e,
		labels:  labels,
		cfg:     cfg,
		timeout: timeout,
		sem:     make(chan struct{}, cfg.MaxConcurrency),
	}
}

// ErrForbidden 表示当前登录态的租户看不到该数据集。handler 映射为 403。
var ErrForbidden = errors.New("forbidden")

// VisibleDatasets 返回当前登录态可见的数据集。
//
// 可见性规则：数据集的租户白名单为空 = 不限制（所有租户可见）；
// 非空 = 登录态租户与白名单有交集才可见。
func (s *Service) VisibleDatasets(ctx context.Context, tenants []string) ([]QueryDataset, error) {
	items, err := s.repo.ListAvailable(ctx, 0)
	if err != nil {
		return nil, err
	}
	// 全局字典只在这里取一次，循环内复用；取不到时降级为空字典（展示回落到字段名）。
	global := map[string]string{}
	if s.labels != nil {
		global = s.labels.Map(ctx)
	}
	out := make([]QueryDataset, 0, len(items))
	for _, it := range items {
		if !it.ACL.Allows(tenants) {
			continue
		}
		dims := filterColumns(it.DimMap, it.ACL, tenants)
		multiDims := filterColumns(it.MultiDimMap, it.ACL, tenants)
		mtxs := filterColumns(it.MtxMap, it.ACL, tenants)
		out = append(out, QueryDataset{
			DatasetKey:  it.DatasetKey,
			DatasetName: it.DatasetName,
			DimMap:      dims,
			MultiDimMap: multiDims,
			MtxMap:      mtxs,
			// 只对「当前数据集真的有、且当前登录态看得见」的列生成中文名：
			// 以 dim_map / multi_dim_map / mtx_map 为准而不是以 label_map 为准，
			// 否则数据集里已经删掉的列、或全局字典里跟本数据集无关的字段都会混进表头。
			LabelMap: mergeLabels(dims, multiDims, mtxs, it.LabelMap, global),
		})
	}
	return out, nil
}

// DryRunRequest 自检请求：一段待验证的配置，不要求已保存。
// 这样新建时也能先验证再落库，不必「保存了才发现 SQL 跑不通」。
type DryRunRequest struct {
	MidSQL      string            `json:"mid_sql"`
	DimMap      map[string]string `json:"dim_map"`
	MultiDimMap map[string]string `json:"multi_dim_map"`
	MtxMap      map[string]string `json:"mtx_map"`
}

// DryRunResult 自检结果。
//
// 刻意不把失败当成接口错误返回：自检的目的就是「告诉我哪里不通」，
// 返回 500 或 400 反而把诊断信息降级成了错误码。所以 SQL 报错一律装在
// result.error 里，接口本身仍然是 200。
type DryRunResult struct {
	OK bool `json:"ok"`
	// Stage 记下失败发生在哪一步，用处是把问题定位到具体位置：
	//   template → mid_sql 的 Go template 语法或渲染有问题
	//   mid      → mid_sql 本身跑不通
	//   expr     → mid_sql 没问题，是 dim_map / mtx_map 的表达式写错了
	Stage       string   `json:"stage,omitempty"`
	Error       string   `json:"error,omitempty"`
	SQL         string   `json:"sql,omitempty"`
	MidColumns  []string `json:"mid_columns"`  // mid_sql 实际输出的列
	Columns     []string `json:"columns"`      // 按 dim/mtx 表达式解析后的列
	CheckedKeys []string `json:"checked_keys"` // 参与校验的字段，报错时可对照
	ElapsedMS   int64    `json:"elapsed_ms"`
}

// DryRun 拿真实 ClickHouse 跑一遍配置，验证 SQL 可执行、字段表达式都存在。
//
// 只取 1 行：自检关心的是「能不能跑通、列对不对」，不关心数据长什么样，
// 也因此不会对线上数仓造成实际压力。执行用的是只读账号，写不进去。
//
// 模板一律「全展开」（所有维度指标都当作要用到）：否则自检只覆盖
// 「什么都不选」这一种渲染分支，用不到的 JOIN 分支里的错误就漏掉了。
func (s *Service) DryRun(ctx context.Context, req DryRunRequest) (*DryRunResult, error) {
	res := &DryRunResult{MidColumns: []string{}, Columns: []string{}, CheckedKeys: []string{}}
	started := time.Now()
	defer func() { res.ElapsedMS = time.Since(started).Milliseconds() }()

	if strings.TrimSpace(req.MidSQL) == "" {
		res.Stage = "template"
		res.Error = "mid_sql 为空"
		return res, nil
	}

	dimKeys := keysOf(req.DimMap)
	multiKeys := keysOf(req.MultiDimMap)
	mtxKeys := keysOf(req.MtxMap)
	// 多值维度既是维度（要参与 HasDim 判断）又需要收拢，
	// 这里统一当成维度传进去渲染，JOIN 裁剪才不会把它依赖的表剪掉。
	all := append(append([]string{}, dimKeys...), multiKeys...)
	all = append(all, mtxKeys...)
	rendered, err := RenderMidSQL(req.MidSQL, MidSQLData{
		Dims:    dedupSorted(append(append([]string{}, dimKeys...), multiKeys...)),
		Metrics: dedupSorted(mtxKeys),
		Fields:  dedupSorted(all),
	})
	if err != nil {
		res.Stage = "template"
		res.Error = err.Error()
		return res, nil
	}

	ctx, cancel := context.WithTimeout(ctx, s.timeout)
	defer cancel()

	// 第一枪：只跑 mid_sql 本身
	midSQLText := BuildDryRunMidSQL(rendered)
	res.SQL = midSQLText
	raw, err := s.engine.Query(ctx, midSQLText, nil)
	if err != nil {
		res.Stage = "mid"
		res.Error = shortErr(err)
		return res, nil
	}
	res.MidColumns = columnNames(raw.Columns)

	// 第二枪：把每个维度 / 指标表达式都选一遍
	aliasSQL, keys, err := BuildDryRunSQL(rendered, req.DimMap, req.MultiDimMap, req.MtxMap)
	if err != nil {
		res.Stage = "expr"
		res.Error = shortErr(err)
		return res, nil
	}
	res.SQL = aliasSQL
	res.CheckedKeys = keys
	got, err := s.engine.Query(ctx, aliasSQL, nil)
	if err != nil {
		res.Stage = "expr"
		res.Error = shortErr(err)
		return res, nil
	}
	res.Columns = columnNames(got.Columns)
	res.OK = true
	return res, nil
}

func keysOf(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

func columnNames(cols []Column) []string {
	out := make([]string, 0, len(cols))
	for _, c := range cols {
		out = append(out, c.Name)
	}
	return out
}

// shortErr 精简 ClickHouse 的报错。原始错误经常带一长串堆栈和内部 Code，
// 有用的通常只有最前面那句。截断避免把 1 MiB 的 SQL 回显进错误信息。
func shortErr(err error) string {
	msg := err.Error()
	if i := strings.Index(msg, "\n"); i > 0 {
		msg = msg[:i]
	}
	if len(msg) > 500 {
		msg = msg[:500] + " …(已截断)"
	}
	return msg
}

// mergeLabels 合并三层命名：数据集覆盖 → 全局定义 → 字段名兜底。
// 多值维度与普通维度共用一套命名规则，它只是聚合方式不同，身份仍然是维度。
//
// 三态是这里的关键，覆盖层的「没有这个 key」和「显式空串」必须区分开：
//   - 覆盖层没有 key            → 继承全局定义
//   - 覆盖层非空                → 覆盖，只作用于本数据集
//   - 覆盖层是 ""（显式空串）   → 明确「不使用中文名」，即使全局有定义也不继承
//     （典型场景：本数据集的同名字段与全局语义不同，又不想另起一个名字）
//
// 兜底由前端完成：map 里没有的字段，前端直接显示字段名本身，这里不写空值。
func mergeLabels(dims, multiDims, mtxs, override, global map[string]string) map[string]string {
	out := make(map[string]string, len(dims)+len(multiDims)+len(mtxs))
	put := func(k string) {
		if v, ok := override[k]; ok {
			// 命中覆盖层：空串也是有意义的显式声明，直接跳过不写
			if v != "" {
				out[k] = v
			}
			return
		}
		if v := global[k]; v != "" {
			out[k] = v
		}
	}
	for k := range dims {
		put(k)
	}
	for k := range multiDims {
		put(k)
	}
	for k := range mtxs {
		put(k)
	}
	return out
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

// buildRowFilters 根据数据集配置与登录态合成行级权限条件。
//
// 列表达式只从服务端持有的 dim_map 里取，绝不采信客户端传入的文本。
// 开启但登录态列表为空时保留空 Values：IN () 不匹配任何行，等价于拒绝——
// 权限配置宁可看不到，也不能看到别人的数据。
func buildRowFilters(ds *model.DatasetConfig, tenants, users []string) []RowFilter {
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
	ds, err := s.repo.GetByKey(ctx, req.DatasetKey)
	if err != nil {
		return nil, err
	}
	if !ds.ACL.Allows(tenants) {
		slog.Warn("query denied by tenant acl",
			"operator", operator, "dataset_key", ds.DatasetKey,
			"tenants", tenants, "acl_tenants", ds.ACL.Tenants,
		)
		return nil, fmt.Errorf("%w: 当前登录态的租户无权访问数据集 %q", ErrForbidden, ds.DatasetKey)
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

	res, err := s.runQuery(ctx, ds, midSQL, req, tenants, users, operator)
	if err != nil {
		return nil, err
	}
	if req.Compare == nil {
		return res, nil
	}
	if err := s.attachCompare(ctx, ds, midSQL, req, res, tenants, users, operator); err != nil {
		return nil, err
	}
	return res, nil
}

// runQuery 把「一份意图 → 一份结果」的完整链路收在一处：
// 组装 SQL、过并发闸门、执行、按上限裁掉探针行、打日志。
// 对比周期需要跑两遍同一件事，抽出来才不会两处各写一遍、慢慢长歪。
func (s *Service) runQuery(
	ctx context.Context,
	ds *model.DatasetConfig,
	midSQL string,
	req *ExecuteRequest,
	tenants, users []string,
	operator string,
) (*ExecuteResult, error) {
	sqlText, params, err := Build(Spec{
		DatasetKey:   ds.DatasetKey,
		MidSQL:       midSQL,
		DimMap:       ds.DimMap,
		MultiDimMap:  ds.MultiDimMap,
		MtxMap:       ds.MtxMap,
		Dims:         req.Dims,
		Metrics:      req.Metrics,
		Filter:       req.Filter,
		RowFilters:   buildRowFilters(ds, tenants, users),
		OrderBy:      req.OrderBy,
		Limit:        req.Limit,
		MaxLimit:     s.cfg.MaxResultRows,
		DefaultLimit: s.cfg.DefaultLimit,
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
			"operator", operator, "dataset_key", ds.DatasetKey,
			"dims", req.Dims, "metrics", req.Metrics,
			"elapsed_ms", elapsed, "error", err,
			"sql", loggableSQL(sqlText), "params", formatParams(params),
		)
		return nil, err
	}

	res.ElapsedMs = elapsed

	// SQL 里多取了一行做「还有更多」的探针，这里把它丢掉并标出截断。
	// 用户在界面上看到的行数必须与「是不是全量」这个结论一致：
	// 显示 50 行、却不说后面还有 890 行，是最容易让人拿着部分数据去汇报的坑。
	if eff := EffectiveLimit(Spec{
		Limit:        req.Limit,
		MaxLimit:     s.cfg.MaxResultRows,
		DefaultLimit: s.cfg.DefaultLimit,
	}); res.RowCount > eff {
		res.Truncated = true
		res.Rows = res.Rows[:eff]
		res.RowCount = eff
	}

	// 成功也把 SQL 打出来：日常排查「这个数是怎么算出来的」主要靠这条日志，
	// 行级权限注入的条件也只在这里能看到全貌。
	slog.Info("query executed",
		"operator", operator, "dataset_key", ds.DatasetKey,
		"dims", req.Dims, "metrics", req.Metrics, "filters", FilterNodeCount(req.Filter),
		"rows", res.RowCount, "truncated", res.Truncated, "elapsed_ms", elapsed,
		"sql", loggableSQL(sqlText), "params", formatParams(params),
	)
	return res, nil
}

// DimValues 返回某个维度的候选值，供前端下拉枚举。
func (s *Service) DimValues(ctx context.Context, datasetKey, field string, tenants, users []string) ([]string, error) {
	ds, err := s.repo.GetByKey(ctx, datasetKey)
	if err != nil {
		return nil, err
	}
	if !ds.ACL.Allows(tenants) {
		return nil, fmt.Errorf("%w: 当前登录态的租户无权访问数据集 %q", ErrForbidden, datasetKey)
	}
	if !ds.ACL.AllowsColumn(field, tenants) {
		return nil, fmt.Errorf("%w: 当前登录态的租户无权访问列 %q", ErrForbidden, field)
	}
	// 多值维度也能枚举候选值，只是取的是数组里的单个元素而不是收拢后的组合串
	expr, isDim := ds.DimMap[field]
	multiExpr, isMulti := ds.MultiDimMap[field]
	if !isDim && !isMulti {
		return nil, fmt.Errorf("%w: 字段 %q 不是该数据集的维度或多值维度", ErrInvalidQuery, field)
	}
	if isMulti {
		expr = multiExpr
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
	var sqlText string
	var params []Param
	if isMulti {
		sqlText, params = BuildMultiDimValuesSQL(midSQL, expr, s.cfg.DimValueLimit, buildRowFilters(ds, tenants, users))
	} else {
		sqlText, params = BuildDimValuesSQL(midSQL, expr, s.cfg.DimValueLimit, buildRowFilters(ds, tenants, users))
	}

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
		slog.Error("dim values query failed", "dataset_key", datasetKey, "field", field,
			"error", err, "sql", loggableSQL(sqlText), "params", formatParams(params))
		return nil, err
	}
	slog.Info("dim values query executed", "dataset_key", datasetKey, "field", field,
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

// ---- 对比周期（同环比）----

// attachCompare 跑一遍上期查询并把结果对齐到 base 上。
//
// 刻意做成「再跑一次同一份查询」而不是在 SQL 里写窗口函数/LAG：
// 数据是按任意维度分组的，上期的行集合和本期不一定一一对应，
// LAG 只能按行号错位对齐，维度组合一变就全错。两次查询 + 按维度元组对齐才是对的。
func (s *Service) attachCompare(
	ctx context.Context,
	ds *model.DatasetConfig,
	midSQL string,
	req *ExecuteRequest,
	base *ExecuteResult,
	tenants, users []string,
	operator string,
) error {
	cmp := req.Compare
	if len(req.Metrics) == 0 {
		return fmt.Errorf("%w: 对比周期需要至少一个指标——纯维度查询没有可比的数", ErrInvalidQuery)
	}
	// 本期结果被截断时，缺失的维度组合会被误当成「上期没有」，
	// 算出来的变化率是错的。宁可让用户先放宽上限，也不给一个看着正常的错数。
	if base.Truncated {
		return fmt.Errorf("%w: 当前结果已按上限截断，环比会漏掉被截掉的分组；请先放宽返回上限或加筛选条件", ErrInvalidQuery)
	}
	expr, ok := ds.DimMap[cmp.Field]
	if !ok || strings.TrimSpace(expr) == "" {
		return fmt.Errorf("%w: 对比字段 %q 必须是普通日期维度（dim_map 的键）", ErrInvalidQuery, cmp.Field)
	}

	from, to, found := FindDateRange(req.Filter, cmp.Field)
	inferred := !found
	if inferred {
		// 用户没设时间范围（默认查全量）：先探一次数据覆盖区间，
		// 否则「上一个等长周期」无从算起。探的是同一份 mid_sql + 同样的行级权限。
		lo, hi, err := s.probeDateRange(ctx, midSQL, expr, buildRowFilters(ds, tenants, users))
		if err != nil {
			return err
		}
		from, to = lo, hi
	}

	baseFrom, err := parseDatePart(from)
	if err != nil {
		return err
	}
	baseTo, err := parseDatePart(to)
	if err != nil {
		return err
	}
	prevFrom, prevTo, err := ShiftPeriod(baseFrom, baseTo, cmp.Mode)
	if err != nil {
		return err
	}

	prevFilter := ReplaceRange(derefFilter(req.Filter), cmp.Field,
		prevFrom.Format(dateLayout), prevTo.Format(dateLayout))

	prevReq := *req
	prevReq.Compare = nil
	prevReq.Filter = &prevFilter

	prevRes, err := s.runQuery(ctx, ds, midSQL, &prevReq, tenants, users, operator)
	if err != nil {
		return err
	}
	prevTruncated := prevRes.Truncated

	// 对比字段本身也是分组维度时（按天看周同比），两期日期不重叠，
	// 必须先把上期日期整体平移到本期时间轴上，否则一行都配不上。
	if idx := indexOfField(req.Dims, cmp.Field); idx >= 0 {
		ShiftDimDates(prevRes, idx, int(baseFrom.Sub(prevFrom).Hours()/24))
	}

	merged, meta := MergeCompare(base, prevRes, req.Dims, req.Metrics)
	meta.Mode = cmp.Mode
	meta.Field = cmp.Field
	meta.BaseFrom = baseFrom.Format(dateLayout)
	meta.BaseTo = baseTo.Format(dateLayout)
	meta.PrevFrom = prevFrom.Format(dateLayout)
	meta.PrevTo = prevTo.Format(dateLayout)
	meta.BaseInferred = inferred
	meta.PrevTruncated = prevTruncated

	*base = *merged
	base.Compare = meta
	return nil
}

// probeDateRange 取某个日期维度的最小 / 最大值。表为空时返回错误，
// 让调用方给出「这段时间没有数据」而不是一个 0001-01-01 的区间。
func (s *Service) probeDateRange(ctx context.Context, midSQL, expr string, rowFilters []RowFilter) (string, string, error) {
	sqlText, params := BuildDateRangeSQL(midSQL, expr, rowFilters)
	res, err := s.engine.Query(ctx, sqlText, params)
	if err != nil {
		return "", "", err
	}
	if len(res.Rows) == 0 || len(res.Rows[0]) < 2 {
		return "", "", fmt.Errorf("%w: 数据里没有可用的日期", ErrInvalidQuery)
	}
	lo := strings.TrimSpace(fmt.Sprintf("%v", res.Rows[0][0]))
	hi := strings.TrimSpace(fmt.Sprintf("%v", res.Rows[0][1]))
	if lo == "" || hi == "" || lo == "<nil>" || hi == "<nil>" {
		return "", "", fmt.Errorf("%w: 数据里没有可用的日期", ErrInvalidQuery)
	}
	return lo, hi, nil
}

func derefFilter(n *FilterNode) FilterNode {
	if n == nil {
		return FilterNode{Logic: LogicAnd}
	}
	return *n
}

// parseDatePart 只取日期部分：日期维度可能带时分秒（stat_ts），
// 比周期时按天对齐就够了，多出来的时间会把「等长周期」算歪。
func parseDatePart(v string) (time.Time, error) {
	v = strings.TrimSpace(v)
	if len(v) > 10 {
		v = v[:10]
	}
	t, err := time.Parse(dateLayout, v)
	if err != nil {
		return time.Time{}, fmt.Errorf("%w: 无法识别的日期 %q", ErrInvalidQuery, v)
	}
	return t, nil
}

// indexOfField 返回字段在维度列表里的下标，没有则 -1。
func indexOfField(list []string, field string) int {
	for i, v := range list {
		if v == field {
			return i
		}
	}
	return -1
}
