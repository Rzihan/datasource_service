package service

import (
	"context"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"time"

	"dataset_service/internal/model"
	"dataset_service/internal/repo"
)

// DatasetFieldLister 提供数据集配置的字段清单，供一致性检查使用。
// 用接口而不是直接依赖 *repo.DatasetRepo：字典服务只需要「列出数据集」这一个能力，
// 接口能明确表达这个边界，也让单测可以塞一个假的进去。
type DatasetFieldLister interface {
	ListAvailable(ctx context.Context, limit int) ([]*model.DatasetConfig, error)
}

// LabelService 承载全局字段名称定义的业务规则，同时充当进程内字典缓存。
type LabelService struct {
	repo *repo.LabelRepo
	// datasets 可为 nil，此时一致性检查会返回空结果而不是报错——
	// 检查是个锦上添花的功能，不该因为没有注入数据集仓库就让整个字典服务起不来。
	datasets DatasetFieldLister

	// 缓存：字典会被每个数据集、每次查询读到，不加缓存等于给每次列表请求多打一次全表。
	// 用 TTL 而不是「写时失效」就够了：多实例部署时本进程的失效通知也送不到别的实例，
	// 与其做一套分布式失效，不如接受最多 TTL 秒的延迟——这是纯展示字段，晚几秒无所谓。
	mu        sync.RWMutex
	cached    map[string]string
	expiresAt time.Time
	ttl       time.Duration
}

// NewLabelService 构造服务。ttl <= 0 时使用默认 30 秒；datasets 可为 nil。
func NewLabelService(r *repo.LabelRepo, datasets DatasetFieldLister, ttl time.Duration) *LabelService {
	if ttl <= 0 {
		ttl = 30 * time.Second
	}
	return &LabelService{repo: r, datasets: datasets, ttl: ttl}
}

// Create 新建全局定义。
func (s *LabelService) Create(ctx context.Context, req *model.GlobalLabelCreateRequest, operator string) (*model.GlobalLabel, error) {
	key, err := normalizeFieldKey(req.FieldKey)
	if err != nil {
		return nil, err
	}
	label, err := normalizeLabel(req.Label)
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
	m := &model.GlobalLabel{
		FieldKey:  key,
		Label:     label,
		Status:    status,
		Version:   0,
		CreatedBy: operator,
		UpdatedBy: operator,
		CreatedAt: now,
		UpdatedAt: now,
	}
	if err := s.repo.Create(ctx, m); err != nil {
		return nil, err
	}
	s.invalidate()
	return m, nil
}

// Get 查询单条定义。
func (s *LabelService) Get(ctx context.Context, key string) (*model.GlobalLabel, error) {
	key, err := normalizeFieldKey(key)
	if err != nil {
		return nil, err
	}
	return s.repo.GetByKey(ctx, key)
}

// List 分页查询。
func (s *LabelService) List(ctx context.Context, q model.GlobalLabelListQuery) (*model.GlobalLabelListResult, error) {
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
	return &model.GlobalLabelListResult{Items: items, Total: total, Page: q.Page, Size: q.Size}, nil
}

// Update 更新中文名与启停状态（乐观锁），字段名不可改。
func (s *LabelService) Update(ctx context.Context, key string, req *model.GlobalLabelUpdateRequest, operator string) (*model.GlobalLabel, error) {
	key, err := normalizeFieldKey(key)
	if err != nil {
		return nil, err
	}
	label, err := normalizeLabel(req.Label)
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

	m := &model.GlobalLabel{
		FieldKey:  key,
		Label:     label,
		Status:    status,
		UpdatedBy: operator,
	}
	if err := s.repo.Update(ctx, m, req.Version); err != nil {
		return nil, err
	}
	s.invalidate()
	return s.repo.GetByKey(ctx, key)
}

// Delete 软删除。
func (s *LabelService) Delete(ctx context.Context, key, operator string) error {
	key, err := normalizeFieldKey(key)
	if err != nil {
		return err
	}
	if err := s.repo.SoftDelete(ctx, key, time.Now().UnixMilli()); err != nil {
		return err
	}
	s.invalidate()
	return nil
}

// Map 返回 field_key → 中文名 的字典（只含未删除且启用的），供查询侧合并使用。
//
// 两个刻意的取舍：
//  1. 读失败时降级为空字典 + 旧缓存，绝不把错误抛给查询主流程。
//     字段名称只影响展示，为了显示中文名而让整个查询失败是本末倒置。
//  2. 返回的是内部 map，调用方只能读不能改（merge 时一律构造新 map）。
func (s *LabelService) Map(ctx context.Context) map[string]string {
	if m, ok := s.fresh(); ok {
		return m
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	// 双检：等锁期间可能已有别的 goroutine 刷新过
	if time.Now().Before(s.expiresAt) && s.cached != nil {
		return s.cached
	}

	items, err := s.repo.ListEnabled(ctx, 0)
	if err != nil {
		slog.Error("load global labels failed, falling back to previous cache", "error", err)
		if s.cached != nil {
			// 有旧数据就先用旧的，同时把过期时间往后推一点，
			// 避免 DB 抖动期间每个请求都去重试、把故障放大。
			s.expiresAt = time.Now().Add(s.ttl)
			return s.cached
		}
		return map[string]string{}
	}

	m := make(map[string]string, len(items))
	for _, it := range items {
		if it.Label == "" {
			continue
		}
		m[it.FieldKey] = it.Label
	}
	s.cached = m
	s.expiresAt = time.Now().Add(s.ttl)
	return m
}

// fresh 读锁下尝试命中缓存。
func (s *LabelService) fresh() (map[string]string, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.cached != nil && time.Now().Before(s.expiresAt) {
		return s.cached, true
	}
	return nil, false
}

// invalidate 写操作后失效本进程缓存。其他实例靠 TTL 兜底。
func (s *LabelService) invalidate() {
	s.mu.Lock()
	s.expiresAt = time.Time{}
	s.mu.Unlock()
}

// Check 扫描「全局字典 × 全部数据集」，把四类会让中文名不生效或不一致的情况列出来。
//
// 存在的理由：全局字典只有一个字段名做 key，跨数据集必然可能同名不同义。
// 这类问题不会报错、只会静默显示错的名字，靠人工逐个数据集比对根本查不完，
// 所以必须由机器扫出来，再由人决定哪些是真冲突、哪些是该同步而没同步。
//
// 四类问题：
//  1. conflicts     数据集覆盖了全局，两者不一致（可能是真同名不同义，也可能是漏同步）
//  2. case_mismatch 数据集字段名与字典大小写不一致，全局定义静默失效
//  3. missing       数据集有这个字段，但哪儿都没给中文名，表头显示原始字段名
//  4. orphans       字典里定义了却没有任何数据集引用（改名 / 删除后的残留）
func (s *LabelService) Check(ctx context.Context) (*model.LabelCheckResult, error) {
	globals, err := s.repo.ListEnabled(ctx, 0)
	if err != nil {
		return nil, fmt.Errorf("load global labels: %w", err)
	}
	global := make(map[string]string, len(globals))
	for _, g := range globals {
		if g.Label != "" {
			global[g.FieldKey] = g.Label
		}
	}

	if s.datasets == nil {
		return &model.LabelCheckResult{GlobalCount: len(global)}, nil
	}
	items, err := s.datasets.ListAvailable(ctx, 0)
	if err != nil {
		return nil, fmt.Errorf("list datasets: %w", err)
	}
	return checkAgainst(ctx, items, global)
}

// checkAgainst 是纯函数：给定数据集列表与全局字典，算出四类问题。
// 单独拆出来是为了能直接单测——扫描逻辑里「显式空串不算缺失」这类分支
// 靠真实数据库构造用例太费劲，而它们恰恰是最容易改坏的地方。
func checkAgainst(_ context.Context, items []*model.DatasetConfig, global map[string]string) (*model.LabelCheckResult, error) {
	res := &model.LabelCheckResult{
		Conflicts:    []model.LabelConflict{},
		CaseMismatch: []model.LabelCaseMismatch{},
		Missing:      []model.LabelMissing{},
		Orphans:      []model.LabelOrphan{},
		GlobalCount:  len(global),
		DatasetCount: len(items),
	}

	conflictMap := make(map[string][]model.LabelOverride)
	missingMap := make(map[string][]string)
	referenced := make(map[string]struct{}, len(global))

	for _, ds := range items {
		fields := append(keysOf(ds.DimMap), keysOf(ds.MtxMap)...)
		sort.Strings(fields)
		for _, k := range fields {
			referenced[k] = struct{}{}

			override, hasOverride := ds.LabelMap[k]
			globalLabel := global[k]

			// 覆盖且与全局不一致：要么是同名不同义（保留），要么是漏同步（该改）
			if hasOverride && override != "" && globalLabel != "" && globalLabel != override {
				conflictMap[k] = append(conflictMap[k], model.LabelOverride{
					DatasetKey: ds.DatasetKey, Label: override,
				})
				continue
			}

			// 字典里没有这个写法，但小写后有 —— 全局定义因为大小写不匹配而静默失效
			if globalLabel == "" && !hasOverride {
				if lower := strings.ToLower(k); lower != k {
					if g, ok := global[lower]; ok {
						res.CaseMismatch = append(res.CaseMismatch, model.LabelCaseMismatch{
							DatasetKey: ds.DatasetKey, FieldKey: k,
							GlobalKey: lower, GlobalLabel: g,
						})
						continue
					}
				}
			}

			// 既没全局也没覆盖 → 表头显示原始字段名。
			// 显式空串是有意为之（不使用中文名），不算缺失。
			if !hasOverride && globalLabel == "" {
				missingMap[k] = append(missingMap[k], ds.DatasetKey)
			}
		}
	}

	for _, k := range sortedKeys(conflictMap) {
		res.Conflicts = append(res.Conflicts, model.LabelConflict{
			FieldKey: k, GlobalLabel: global[k], Overrides: conflictMap[k],
		})
	}
	for _, k := range sortedKeys(missingMap) {
		res.Missing = append(res.Missing, model.LabelMissing{FieldKey: k, Datasets: missingMap[k]})
	}
	for _, k := range sortedKeys(global) {
		if _, ok := referenced[k]; !ok {
			res.Orphans = append(res.Orphans, model.LabelOrphan{FieldKey: k, Label: global[k]})
		}
	}
	return res, nil
}

func keysOf(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

func sortedKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func normalizeFieldKey(raw string) (string, error) {
	// 与 dataset_key 共用同一套规则：强制小写。
	// MySQL 默认 collation 不区分大小写，若允许大小写混用，Cost 与 cost 会被判为同一条。
	key := strings.ToLower(strings.TrimSpace(raw))
	if key == "" {
		return "", fmt.Errorf("%w: field_key must not be empty", ErrInvalid)
	}
	if !keyPattern.MatchString(key) {
		return "", fmt.Errorf("%w: field_key %q must match %s", ErrInvalid, raw, keyPattern.String())
	}
	return key, nil
}

func normalizeLabel(raw string) (string, error) {
	label := strings.TrimSpace(raw)
	if label == "" {
		return "", fmt.Errorf("%w: label must not be empty", ErrInvalid)
	}
	if len(label) > maxNameLen {
		return "", fmt.Errorf("%w: label exceeds %d bytes", ErrInvalid, maxNameLen)
	}
	return label, nil
}
