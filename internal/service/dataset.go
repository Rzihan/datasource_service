package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"dataset_service/internal/model"
	"dataset_service/internal/repo"
)

// ErrInvalid 表示入参不合法，handler 会将其映射为 400。
var ErrInvalid = errors.New("invalid argument")

// dataset_key 的合法格式：小写字母/数字开头，允许下划线、短横线、点号。
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

// DatasetService 承载业务规则与入参校验。
type DatasetService struct {
	repo        *repo.DatasetRepo
	maxSQLBytes int
}

// NewDatasetService 构造 service。
func NewDatasetService(r *repo.DatasetRepo, maxSQLBytes int) *DatasetService {
	return &DatasetService{repo: r, maxSQLBytes: maxSQLBytes}
}

// Create 新建配置。dataset_key 会被规范化为小写。
func (s *DatasetService) Create(ctx context.Context, req *model.CreateRequest, operator string) (*model.DatasetConfig, error) {
	key, err := normalizeKey(req.DatasetKey)
	if err != nil {
		return nil, err
	}
	name, err := normalizeName(req.DatasetName)
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
	multiDimMap, err := normalizeStringMap(req.MultiDimMap, "multi_dim_map")
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
	if err := checkFieldKeyUnique(dimMap, multiDimMap, mtxMap); err != nil {
		return nil, err
	}
	acl, err := normalizeACL(req.ACL, dimMap, multiDimMap, mtxMap)
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
	m := &model.DatasetConfig{
		DatasetKey:  key,
		DatasetName: name,
		MidSQL:      req.MidSQL,
		DimMap:      dimMap,
		MultiDimMap: multiDimMap,
		MtxMap:      mtxMap,
		LabelMap:    labelMap,
		ACL:         acl,
		Meta:        metaFrom(req.Meta),
		Status:      status,
		Version:     0,
		CreatedBy:   operator,
		UpdatedBy:   operator,
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	if err := s.repo.Create(ctx, m); err != nil {
		return nil, err
	}
	s.saveHistory(ctx, m, model.ActionCreate, operator)
	return m, nil
}

// saveHistory 写变更快照。历史是审计与回滚能力，写失败不应该让主流程失败——
// 配置已经落库了，因为记不下历史而返回错误，反而会让用户以为没保存成功。
func (s *DatasetService) saveHistory(ctx context.Context, m *model.DatasetConfig, action, operator string) {
	h := &model.DatasetHistory{
		DatasetKey: m.DatasetKey,
		Version:    m.Version,
		Action:     action,
		Operator:   operator,
		Snapshot:   *m,
	}
	if err := s.repo.SaveHistory(ctx, h); err != nil {
		slog.Error("save dataset history failed", "dataset_key", m.DatasetKey, "action", action, "error", err)
	}
}

// Get 查询单条配置。
func (s *DatasetService) Get(ctx context.Context, key string) (*model.DatasetConfig, error) {
	key, err := normalizeKey(key)
	if err != nil {
		return nil, err
	}
	return s.repo.GetByKey(ctx, key)
}

// List 分页查询，并在此兜底修正分页参数。
func (s *DatasetService) List(ctx context.Context, q model.ListQuery) (*model.ListResult, error) {
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
func (s *DatasetService) Update(ctx context.Context, key string, req *model.UpdateRequest, operator string) (*model.DatasetConfig, error) {
	key, err := normalizeKey(key)
	if err != nil {
		return nil, err
	}
	name, err := normalizeName(req.DatasetName)
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
	multiDimMap, err := normalizeStringMap(req.MultiDimMap, "multi_dim_map")
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
	if err := checkFieldKeyUnique(dimMap, multiDimMap, mtxMap); err != nil {
		return nil, err
	}
	acl, err := normalizeACL(req.ACL, dimMap, multiDimMap, mtxMap)
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

	// 没传说明书就沿用原值：配置页保存时不该顺手把别人写的口径清空。
	// 只有显式传了 meta 才覆盖（传 {} 就是「清空」）。
	meta := model.DatasetMeta{}
	if req.Meta != nil {
		meta = normalizeMeta(*req.Meta)
	} else if cur, err := s.repo.GetByKey(ctx, key); err == nil {
		meta = cur.Meta
	}

	m := &model.DatasetConfig{
		DatasetKey:  key,
		DatasetName: name,
		MidSQL:      req.MidSQL,
		DimMap:      dimMap,
		MultiDimMap: multiDimMap,
		MtxMap:      mtxMap,
		LabelMap:    labelMap,
		ACL:         acl,
		Meta:        meta,
		Status:      status,
		UpdatedBy:   operator,
	}
	if err := s.repo.Update(ctx, m, req.Version); err != nil {
		return nil, err
	}
	after, err := s.repo.GetByKey(ctx, key)
	if err != nil {
		return nil, err
	}
	s.saveHistory(ctx, after, model.ActionUpdate, operator)
	return after, nil
}

// Delete 软删除。删除前先把最后状态存进历史，否则这条配置就彻底找不回来了。
func (s *DatasetService) Delete(ctx context.Context, key, operator string) error {
	key, err := normalizeKey(key)
	if err != nil {
		return err
	}
	before, err := s.repo.GetByKey(ctx, key)
	if err != nil {
		return err
	}
	if err := s.repo.SoftDelete(ctx, key, time.Now().UnixMilli()); err != nil {
		return err
	}
	s.saveHistory(ctx, before, model.ActionDelete, operator)
	return nil
}

// Histories 返回某数据集的变更历史（按时间倒序）。
func (s *DatasetService) Histories(ctx context.Context, key string, limit int) (*model.HistoryResult, error) {
	key, err := normalizeKey(key)
	if err != nil {
		return nil, err
	}
	items, err := s.repo.ListHistory(ctx, key, limit)
	if err != nil {
		return nil, err
	}
	return &model.HistoryResult{Items: items}, nil
}

// Rollback 把配置恢复到某条历史记录的样子。
//
// 两条安全约束：
//  1. 历史必须属于这个数据集——否则用 A 的接口能回滚出 B 的配置，等于越权写入。
//  2. 回滚本身也是一次变更，会再记一条历史，所以回滚可以再被回滚。
func (s *DatasetService) Rollback(ctx context.Context, key string, req *model.RollbackRequest, operator string) (*model.DatasetConfig, error) {
	key, err := normalizeKey(key)
	if err != nil {
		return nil, err
	}
	if req == nil || req.HistoryID == 0 {
		return nil, fmt.Errorf("%w: history_id must not be empty", ErrInvalid)
	}
	h, err := s.repo.GetHistory(ctx, req.HistoryID)
	if err != nil {
		return nil, err
	}
	if h.DatasetKey != key {
		return nil, repo.ErrHistoryMismatch
	}
	snap := h.Snapshot

	target := &model.DatasetConfig{
		DatasetKey:  key,
		DatasetName: snap.DatasetName,
		MidSQL:      snap.MidSQL,
		DimMap:      snap.DimMap,
		MultiDimMap: snap.MultiDimMap,
		MtxMap:      snap.MtxMap,
		LabelMap:    snap.LabelMap,
		ACL:         snap.ACL,
		Status:      snap.Status,
		UpdatedBy:   operator,
	}

	cur, err := s.repo.GetByKey(ctx, key)
	switch {
	case err == nil:
		// 还在：整体覆盖。取当前版本做乐观锁，并发下冲突返回 409 而不是静默覆盖。
		if err := s.repo.Update(ctx, target, cur.Version); err != nil {
			return nil, err
		}
	case errors.Is(err, repo.ErrNotFound):
		// 已被删除：相当于复活。版本号归零重开。
		target.CreatedBy = operator
		target.Version = 0
		if err := s.repo.Create(ctx, target); err != nil {
			return nil, err
		}
	default:
		return nil, err
	}

	after, err := s.repo.GetByKey(ctx, key)
	if err != nil {
		return nil, err
	}
	s.saveHistory(ctx, after, model.ActionRollback, operator)
	return after, nil
}

// MigrateMultiDim 把若干字段从 dim_map / mtx_map 搬进 multi_dim_map。
//
// 存在的原因：多值维度以前没地方放，只能塞进 mtx_map 当指标。现在有了正地方，
// 让人手抄一遍表达式既慢又容易抄错，所以给一条一键迁移的路径。
//
// 两点刻意的设计：
//  1. 只搬字段、不动别的。迁移前后其余配置逐字不变，出问题能一眼定位到「搬了哪个字段」。
//  2. 带乐观锁。从「扫描出结果」到「点迁移」之间别人可能已经改过配置，
//     不带 version 就会把别人的改动盖掉。
func (s *DatasetService) MigrateMultiDim(ctx context.Context, key string, req *model.MigrateMultiDimRequest, operator string) (*model.DatasetConfig, error) {
	key, err := normalizeKey(key)
	if err != nil {
		return nil, err
	}
	if len(req.Items) == 0 {
		return nil, fmt.Errorf("%w: items 不能为空", ErrInvalid)
	}
	cur, err := s.repo.GetByKey(ctx, key)
	if err != nil {
		return nil, err
	}

	dimMap := copyStringMap(cur.DimMap)
	multiDimMap := copyStringMap(cur.MultiDimMap)
	mtxMap := copyStringMap(cur.MtxMap)

	// 行级权限的列必须留在 dim_map：搬走了 buildRowFilters 会取不到表达式，
	// 权限条件静默失效（fail-open），这比报错危险得多。
	rfCols := map[string]bool{}
	if c := cur.ACL.RowFilter.Tenant.Column; c != "" {
		rfCols[c] = true
	}
	if c := cur.ACL.RowFilter.User.Column; c != "" {
		rfCols[c] = true
	}

	for _, it := range req.Items {
		f := strings.TrimSpace(it.Field)
		expr := strings.TrimSpace(it.Expr)
		if f == "" {
			return nil, fmt.Errorf("%w: items 里有空的 field", ErrInvalid)
		}
		if expr == "" {
			return nil, fmt.Errorf("%w: 字段 %q 缺少迁移后的表达式", ErrInvalid, f)
		}
		if _, ok := multiDimMap[f]; ok {
			return nil, fmt.Errorf("%w: 字段 %q 已经是多值维度了", ErrInvalid, f)
		}
		_, fromDim := dimMap[f]
		_, fromMtx := mtxMap[f]
		if !fromDim && !fromMtx {
			return nil, fmt.Errorf("%w: 字段 %q 不在该数据集的 dim_map / mtx_map 中", ErrInvalid, f)
		}
		if rfCols[f] {
			return nil, fmt.Errorf("%w: 字段 %q 被行级权限用作过滤列，搬走会让权限条件失效；请先改掉行级权限配置", ErrInvalid, f)
		}
		delete(dimMap, f)
		delete(mtxMap, f)
		multiDimMap[f] = expr
	}

	m := &model.DatasetConfig{
		DatasetKey:  cur.DatasetKey,
		DatasetName: cur.DatasetName,
		MidSQL:      cur.MidSQL,
		DimMap:      dimMap,
		MultiDimMap: multiDimMap,
		MtxMap:      mtxMap,
		LabelMap:    cur.LabelMap,
		ACL:         cur.ACL,
		Status:      cur.Status,
		UpdatedBy:   operator,
	}
	if err := s.repo.Update(ctx, m, req.Version); err != nil {
		return nil, err
	}
	after, err := s.repo.GetByKey(ctx, key)
	if err != nil {
		return nil, err
	}
	s.saveHistory(ctx, after, model.ActionMigrate, operator)
	return after, nil
}

func copyStringMap(m map[string]string) map[string]string {
	out := make(map[string]string, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

// Validate 只做结构与长度校验，不落库。供前端在提交前实时调用。
// 注意：按约定，mid_sql 不做语法或语义校验。
func (s *DatasetService) Validate(ctx context.Context, req *model.ValidateRequest) error {
	if _, err := normalizeStringMap(req.DimMap, "dim_map"); err != nil {
		return err
	}
	if _, err := normalizeStringMap(req.MultiDimMap, "multi_dim_map"); err != nil {
		return err
	}
	if _, err := normalizeStringMap(req.MtxMap, "mtx_map"); err != nil {
		return err
	}
	if _, err := normalizeStringMap(req.LabelMap, "label_map"); err != nil {
		return err
	}
	if err := checkFieldKeyUnique(req.DimMap, req.MultiDimMap, req.MtxMap); err != nil {
		return err
	}
	if _, err := normalizeACL(req.ACL, req.DimMap, req.MultiDimMap, req.MtxMap); err != nil {
		return err
	}
	return nil
}

// checkFieldKeyUnique 同一个字段名只能属于一种类型。
//
// 存在的原因：三种字段类型的处理完全不同（进不进 GROUP BY、是不是聚合函数），
// 一个 key 挂两种类型时，生成 SQL 的一端只能二选一——选了谁都是静默的错。
// 与其让它在查询时表现为「重复列名」或「结果莫名少一半」，不如在保存时就挡住。
func checkFieldKeyUnique(dimMap, multiDimMap, mtxMap map[string]string) error {
	seen := make(map[string]string, len(dimMap)+len(multiDimMap)+len(mtxMap))
	put := func(m map[string]string, kind string) error {
		for k := range m {
			if prev, ok := seen[k]; ok {
				return fmt.Errorf("%w: 字段 %q 同时出现在 %s 和 %s 中，一个字段只能是维度、多值维度、指标中的一种",
					ErrInvalid, k, prev, kind)
			}
			seen[k] = kind
		}
		return nil
	}
	if err := put(dimMap, "dim_map"); err != nil {
		return err
	}
	if err := put(multiDimMap, "multi_dim_map"); err != nil {
		return err
	}
	return put(mtxMap, "mtx_map")
}

// checkMidSQL 只校验长度。mid_sql 的内容不做任何语法或语义校验（按需求约定）。
// 这里的长度上限是防滥用：避免有人把超大文本塞进配置表把存储撑爆。
func (s *DatasetService) checkMidSQL(sql string) error {
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
//   - col_tenants 的 key 必须是该数据集 dim_map / mtx_map 的键：
//     拼错 key 会让该列静默保持可见（权限配置 fail-open），所以必须挡住并报清楚
func normalizeACL(a model.ACL, dimMap, multiDimMap, mtxMap map[string]string) (model.ACL, error) {
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
		_, isMulti := multiDimMap[col]
		_, isMtx := mtxMap[col]
		if !isDim && !isMulti && !isMtx {
			return model.ACL{}, fmt.Errorf("%w: acl.col_tenants 的 %q 不是该数据集的维度、多值维度或指标", ErrInvalid, col)
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

	rowFilter, err := normalizeRowFilter(a.RowFilter, dimMap)
	if err != nil {
		return model.ACL{}, err
	}

	return model.ACL{Tenants: tenants, ColTenants: colTenants, RowFilter: rowFilter}, nil
}

// normalizeRowFilter 校验行级过滤配置。
//
// 只能映射到 dim_map 的键：行级过滤发生在聚合前，而 mtx_map 的表达式是聚合结果
// （sum(...) 之类），放进 WHERE 会直接报错。所以指标键在这里必须挡住。
func normalizeRowFilter(r model.RowFilter, dimMap map[string]string) (model.RowFilter, error) {
	normalize := func(rule model.RowRule, field string) (model.RowRule, error) {
		if !rule.Enabled {
			// 关闭时把列名一起清掉，避免留下看不出作用的配置
			return model.RowRule{}, nil
		}
		col := strings.TrimSpace(rule.Column)
		if col == "" {
			return model.RowRule{}, fmt.Errorf("%w: %s 已开启但 column 为空", ErrInvalid, field)
		}
		if _, ok := dimMap[col]; !ok {
			return model.RowRule{}, fmt.Errorf("%w: %s 的 column %q 必须是该数据集 dim_map 里的维度（行级过滤发生在聚合前，不能映射到指标）", ErrInvalid, field, col)
		}
		return model.RowRule{Enabled: true, Column: col}, nil
	}

	tenant, err := normalize(r.Tenant, "acl.row_filter.tenant")
	if err != nil {
		return model.RowFilter{}, err
	}
	user, err := normalize(r.User, "acl.row_filter.user")
	if err != nil {
		return model.RowFilter{}, err
	}
	return model.RowFilter{Tenant: tenant, User: user}, nil
}

func normalizeKey(raw string) (string, error) {
	key := strings.ToLower(strings.TrimSpace(raw))
	if key == "" {
		return "", fmt.Errorf("%w: dataset_key must not be empty", ErrInvalid)
	}
	if !keyPattern.MatchString(key) {
		return "", fmt.Errorf("%w: dataset_key %q must match %s", ErrInvalid, raw, keyPattern.String())
	}
	return key, nil
}

func normalizeName(raw string) (string, error) {
	name := strings.TrimSpace(raw)
	if name == "" {
		return "", fmt.Errorf("%w: dataset_name must not be empty", ErrInvalid)
	}
	if utf8.RuneCountInString(name) > maxNameLen {
		return "", fmt.Errorf("%w: dataset_name exceeds %d characters", ErrInvalid, maxNameLen)
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

// metaFrom 请求里带了说明书就规范化一份，没带就是空（新建时即「暂无说明书」）。
// 更新场景不走这里——那里要区分「没传」与「传了空」，见 Update。
func metaFrom(m *model.DatasetMeta) model.DatasetMeta {
	if m == nil {
		return model.DatasetMeta{}
	}
	return normalizeMeta(*m)
}

// normalizeMeta 收敛用户填的说明书：去掉首尾空白、丢掉空条目。
// 不做格式校验——它只影响提示文案，写错了顶多是「说明不准」，
// 不像 map 写错会让整条查询报错，没必要在这里卡住用户。
func normalizeMeta(m model.DatasetMeta) model.DatasetMeta {
	out := model.DatasetMeta{
		Description: strings.TrimSpace(m.Description),
		Owner:       strings.TrimSpace(m.Owner),
		UpdateFreq:  strings.TrimSpace(m.UpdateFreq),
	}
	for _, t := range m.Tags {
		if t = strings.TrimSpace(t); t != "" {
			out.Tags = append(out.Tags, t)
		}
	}
	notes := make(map[string]string, len(m.FieldNotes))
	for k, v := range m.FieldNotes {
		if k = strings.TrimSpace(k); k == "" {
			continue
		}
		if v = strings.TrimSpace(v); v == "" {
			continue
		}
		notes[k] = v
	}
	if len(notes) > 0 {
		out.FieldNotes = notes
	}
	for _, e := range m.Examples {
		title := strings.TrimSpace(e.Title)
		query := strings.TrimSpace(e.Query)
		if title == "" || query == "" {
			continue
		}
		out.Examples = append(out.Examples, model.MetaExample{
			Title: title,
			Note:  strings.TrimSpace(e.Note),
			Query: query,
		})
	}
	return out
}
