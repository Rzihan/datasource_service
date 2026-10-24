package service

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"datasource_service/internal/model"
	"datasource_service/internal/repo"
)

// ErrInvalid 表示入参不合法，handler 会将其映射为 400。
var ErrInvalid = errors.New("invalid argument")

// datasource_key 的合法格式：小写字母/数字开头，允许下划线、短横线、点号。
// 之所以强制小写，是因为 MySQL 默认 collation (utf8mb4_0900_ai_ci) 不区分大小写，
// 若允许大小写混用，Order_DS 与 order_ds 会被判定为同一条而误报冲突。
var keyPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_.\-]{1,63}$`)

const (
	maxNameLen     = 128
	maxKeyLen      = 200 // 单个 map 允许的键数量
	maxValLen      = 1024
	maxTenantLen   = 64
	maxTenantCount = 64
)

// DatasourceService 承载业务规则与入参校验。
type DatasourceService struct {
	repo        *repo.DatasourceRepo
	maxSQLBytes int
}

// NewDatasourceService 构造 service。
func NewDatasourceService(r *repo.DatasourceRepo, maxSQLBytes int) *DatasourceService {
	return &DatasourceService{repo: r, maxSQLBytes: maxSQLBytes}
}

// Create 新建配置。datasource_key 会被规范化为小写。
func (s *DatasourceService) Create(ctx context.Context, req *model.CreateRequest, operator string) (*model.DatasourceConfig, error) {
	key, err := normalizeKey(req.DatasourceKey)
	if err != nil {
		return nil, err
	}
	name, err := normalizeName(req.DatasourceName)
	if err != nil {
		return nil, err
	}
	if err := s.checkMidSQL(req.MidSQL); err != nil {
		return nil, err
	}
	dimMap, err := normalizeStringMap(req.DimMap, "dim_map")
	if err != nil {
		return nil, err
	}
	mtxMap, err := normalizeStringMap(req.MtxMap, "mtx_map")
	if err != nil {
		return nil, err
	}
	labelMap, err := normalizeStringMap(req.LabelMap, "label_map")
	if err != nil {
		return nil, err
	}
	acl, err := normalizeACL(req.ACL, dimMap, mtxMap)
	if err != nil {
		return nil, err
	}
	status := model.StatusEnabled
	if req.Status != nil {
		status = *req.Status
		if err := checkStatus(status); err != nil {
			return nil, err
		}
	}

	now := time.Now()
	m := &model.DatasourceConfig{
		DatasourceKey:  key,
		DatasourceName: name,
		MidSQL:         req.MidSQL,
		DimMap:         dimMap,
		MtxMap:         mtxMap,
		LabelMap:       labelMap,
		ACL:            acl,
		Status:         status,
		Version:        0,
		CreatedBy:      operator,
		UpdatedBy:      operator,
		CreatedAt:      now,
		UpdatedAt:      now,
	}
	if err := s.repo.Create(ctx, m); err != nil {
		return nil, err
	}
	return m, nil
}

// Get 查询单条配置。
func (s *DatasourceService) Get(ctx context.Context, key string) (*model.DatasourceConfig, error) {
	key, err := normalizeKey(key)
	if err != nil {
		return nil, err
	}
	return s.repo.GetByKey(ctx, key)
}

// List 分页查询，并在此兜底修正分页参数。
func (s *DatasourceService) List(ctx context.Context, q model.ListQuery) (*model.ListResult, error) {
	if q.Page <= 0 {
		q.Page = 1
	}
	if q.Size <= 0 {
		q.Size = 20
	}
	if q.Size > 200 {
		q.Size = 200
	}
	items, total, err := s.repo.List(ctx, q)
	if err != nil {
		return nil, err
	}
	return &model.ListResult{Items: items, Total: total, Page: q.Page, Size: q.Size}, nil
}

// Update 全量更新，带乐观锁。
func (s *DatasourceService) Update(ctx context.Context, key string, req *model.UpdateRequest, operator string) (*model.DatasourceConfig, error) {
	key, err := normalizeKey(key)
	if err != nil {
		return nil, err
	}
	name, err := normalizeName(req.DatasourceName)
	if err != nil {
		return nil, err
	}
	if err := s.checkMidSQL(req.MidSQL); err != nil {
		return nil, err
	}
	dimMap, err := normalizeStringMap(req.DimMap, "dim_map")
	if err != nil {
		return nil, err
	}
	mtxMap, err := normalizeStringMap(req.MtxMap, "mtx_map")
	if err != nil {
		return nil, err
	}
	labelMap, err := normalizeStringMap(req.LabelMap, "label_map")
	if err != nil {
		return nil, err
	}
	acl, err := normalizeACL(req.ACL, dimMap, mtxMap)
	if err != nil {
		return nil, err
	}
	status := model.StatusEnabled
	if req.Status != nil {
		status = *req.Status
		if err := checkStatus(status); err != nil {
			return nil, err
		}
	}

	m := &model.DatasourceConfig{
		DatasourceKey:  key,
		DatasourceName: name,
		MidSQL:         req.MidSQL,
		DimMap:         dimMap,
		MtxMap:         mtxMap,
		LabelMap:       labelMap,
		ACL:            acl,
		Status:         status,
		UpdatedBy:      operator,
	}
	if err := s.repo.Update(ctx, m, req.Version); err != nil {
		return nil, err
	}
	return s.repo.GetByKey(ctx, key)
}

// Delete 软删除。
func (s *DatasourceService) Delete(ctx context.Context, key, operator string) error {
	key, err := normalizeKey(key)
	if err != nil {
		return err
	}
	return s.repo.SoftDelete(ctx, key, time.Now().UnixMilli())
}

// Validate 只做结构与长度校验，不落库。供前端在提交前实时调用。
// 注意：按约定，mid_sql 不做语法或语义校验。
func (s *DatasourceService) Validate(ctx context.Context, req *model.ValidateRequest) error {
	if _, err := normalizeStringMap(req.DimMap, "dim_map"); err != nil {
		return err
	}
	if _, err := normalizeStringMap(req.MtxMap, "mtx_map"); err != nil {
		return err
	}
	if _, err := normalizeStringMap(req.LabelMap, "label_map"); err != nil {
		return err
	}
	if _, err := normalizeACL(req.ACL, req.DimMap, req.MtxMap); err != nil {
		return err
	}
	return nil
}

// checkMidSQL 只校验长度。mid_sql 的内容不做任何语法或语义校验（按需求约定）。
// 这里的长度上限是防滥用：避免有人把超大文本塞进配置表把存储撑爆。
func (s *DatasourceService) checkMidSQL(sql string) error {
	if strings.TrimSpace(sql) == "" {
		return fmt.Errorf("%w: mid_sql must not be empty", ErrInvalid)
	}
	if n := len(sql); n > s.maxSQLBytes {
		return fmt.Errorf("%w: mid_sql is %d bytes, exceeds the %d bytes limit", ErrInvalid, n, s.maxSQLBytes)
	}
	return nil
}

// normalizeTenantList 去空白、丢弃空串、去重并排序，保证落库稳定、便于比对。
func normalizeTenantList(in []string, field string) ([]string, error) {
	seen := make(map[string]struct{}, len(in))
	out := make([]string, 0, len(in))
	for _, t := range in {
		tt := strings.TrimSpace(t)
		if tt == "" {
			continue
		}
		if len(tt) > maxTenantLen {
			return nil, fmt.Errorf("%w: %s 中的租户 %q exceeds %d bytes", ErrInvalid, field, t, maxTenantLen)
		}
		if _, ok := seen[tt]; ok {
			continue
		}
		seen[tt] = struct{}{}
		out = append(out, tt)
	}
	if len(out) > maxTenantCount {
		return nil, fmt.Errorf("%w: %s 租户数量超过 %d", ErrInvalid, field, maxTenantCount)
	}
	sort.Strings(out)
	return out, nil
}

// normalizeACL 校验并归一化访问控制：
//   - 租户列表去空白、去重、排序；空列表一律落成 {} 而不是 {"tenants":null}
//     ——null 会被 JSON 函数当成「有一个元素」，把「不限制」误判成「受限」
//   - col_tenants 的 key 必须是该数据源 dim_map / mtx_map 的键：
//     拼错 key 会让该列静默保持可见（权限配置 fail-open），所以必须挡住并报清楚
func normalizeACL(a model.ACL, dimMap, mtxMap map[string]string) (model.ACL, error) {
	tenants, err := normalizeTenantList(a.Tenants, "acl.tenants")
	if err != nil {
		return model.ACL{}, err
	}

	colTenants := make(map[string][]string, len(a.ColTenants))
	for col, list := range a.ColTenants {
		col = strings.TrimSpace(col)
		if col == "" {
			return model.ACL{}, fmt.Errorf("%w: acl.col_tenants 存在空的列名", ErrInvalid)
		}
		_, isDim := dimMap[col]
		_, isMtx := mtxMap[col]
		if !isDim && !isMtx {
			return model.ACL{}, fmt.Errorf("%w: acl.col_tenants 的 %q 不是该数据源的维度或指标", ErrInvalid, col)
		}
		norm, err := normalizeTenantList(list, fmt.Sprintf("acl.col_tenants[%q]", col))
		if err != nil {
			return model.ACL{}, err
		}
		// 空列表等价于「不限制」，直接不落这一项，JSON 更干净
		if len(norm) == 0 {
			continue
		}
		colTenants[col] = norm
	}

	return model.ACL{Tenants: tenants, ColTenants: colTenants}, nil
}

func normalizeKey(raw string) (string, error) {
	key := strings.ToLower(strings.TrimSpace(raw))
	if key == "" {
		return "", fmt.Errorf("%w: datasource_key must not be empty", ErrInvalid)
	}
	if !keyPattern.MatchString(key) {
		return "", fmt.Errorf("%w: datasource_key %q must match %s", ErrInvalid, raw, keyPattern.String())
	}
	return key, nil
}

func normalizeName(raw string) (string, error) {
	name := strings.TrimSpace(raw)
	if name == "" {
		return "", fmt.Errorf("%w: datasource_name must not be empty", ErrInvalid)
	}
	if utf8.RuneCountInString(name) > maxNameLen {
		return "", fmt.Errorf("%w: datasource_name exceeds %d characters", ErrInvalid, maxNameLen)
	}
	return name, nil
}

func checkStatus(status int8) error {
	if status != model.StatusEnabled && status != model.StatusDisabled {
		return fmt.Errorf("%w: status must be 0 or 1", ErrInvalid)
	}
	return nil
}

// normalizeStringMap 校验 map[string]string：
//   - nil 归一化为空 map（避免 JSON 序列化成 null 撞上 NOT NULL 约束）
//   - key 去空白后必须非空，且不能含前后空白
//   - 值长度设上限
func normalizeStringMap(m map[string]string, field string) (map[string]string, error) {
	out := make(map[string]string, len(m))
	if m == nil {
		return out, nil
	}
	if len(m) > maxKeyLen {
		return nil, fmt.Errorf("%w: %s has too many entries (max %d)", ErrInvalid, field, maxKeyLen)
	}
	for k, v := range m {
		kk := strings.TrimSpace(k)
		if kk == "" {
			return nil, fmt.Errorf("%w: %s contains an empty key", ErrInvalid, field)
		}
		if kk != k {
			return nil, fmt.Errorf("%w: %s key %q has leading or trailing whitespace", ErrInvalid, field, k)
		}
		if len(v) > maxValLen {
			return nil, fmt.Errorf("%w: %s[%q] value exceeds %d bytes", ErrInvalid, field, k, maxValLen)
		}
		out[kk] = v
	}
	return out, nil
}
