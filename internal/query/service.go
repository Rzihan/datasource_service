package query

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"datasource_service/internal/config"
	"datasource_service/internal/repo"
)

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
		out = append(out, QueryDatasource{
			DatasourceKey:  it.DatasourceKey,
			DatasourceName: it.DatasourceName,
			DimMap:         it.DimMap,
			MtxMap:         it.MtxMap,
			LabelMap:       it.LabelMap,
			ACL:            it.ACL,
		})
	}
	return out, nil
}

// Execute 执行一次查询。
func (s *Service) Execute(ctx context.Context, req *ExecuteRequest, operator string, tenants []string) (*ExecuteResult, error) {
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

	sqlText, params, err := Build(Spec{
		DatasourceKey: ds.DatasourceKey,
		MidSQL:        ds.MidSQL,
		DimMap:        ds.DimMap,
		MtxMap:        ds.MtxMap,
		Dims:          req.Dims,
		Metrics:       req.Metrics,
		Filter:        req.Filter,
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
			"elapsed_ms", elapsed, "error", err, "sql", sqlText,
		)
		return nil, err
	}

	res.ElapsedMs = elapsed
	slog.Info("query executed",
		"operator", operator, "datasource_key", ds.DatasourceKey,
		"dims", req.Dims, "metrics", req.Metrics, "filters", FilterNodeCount(req.Filter),
		"rows", res.RowCount, "truncated", res.Truncated, "elapsed_ms", elapsed,
	)
	return res, nil
}

// DimValues 返回某个维度的候选值，供前端下拉枚举。
func (s *Service) DimValues(ctx context.Context, datasourceKey, field string, tenants []string) ([]string, error) {
	ds, err := s.repo.GetByKey(ctx, datasourceKey)
	if err != nil {
		return nil, err
	}
	if !ds.ACL.Allows(tenants) {
		return nil, fmt.Errorf("%w: 当前登录态的租户无权访问数据源 %q", ErrForbidden, datasourceKey)
	}
	expr, ok := ds.DimMap[field]
	if !ok {
		return nil, fmt.Errorf("%w: 字段 %q 不是该数据源的维度", ErrInvalidQuery, field)
	}

	sqlText := BuildDimValuesSQL(ds.MidSQL, expr, s.cfg.DimValueLimit)

	select {
	case s.sem <- struct{}{}:
		defer func() { <-s.sem }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}

	queryCtx, cancel := context.WithTimeout(ctx, s.timeout)
	defer cancel()

	res, err := s.engine.Query(queryCtx, sqlText, nil)
	if err != nil {
		slog.Error("dim values query failed", "datasource_key", datasourceKey, "field", field, "error", err, "sql", sqlText)
		return nil, err
	}

	values := make([]string, 0, len(res.Rows))
	for _, row := range res.Rows {
		if len(row) == 0 || row[0] == nil {
			continue
		}
		values = append(values, fmt.Sprint(row[0]))
	}
	return values, nil
}
