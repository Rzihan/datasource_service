package repo

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"dataset_service/internal/model"

	"gorm.io/gorm"
)

// 领域错误，由 handler 映射为 HTTP 状态码。
var (
	ErrNotFound        = errors.New("dataset not found")
	ErrDuplicateKey    = errors.New("dataset_key already exists")
	ErrVersionConflict = errors.New("version conflict, please reload and retry")
)

// DatasetConfigModel 是 repo 层使用的实体别名，避免 repo 直接依赖 model 的 JSON 标签语义。
type DatasetConfigModel = model.DatasetConfig

// DatasetRepo 配置表的数据访问层。
type DatasetRepo struct {
	db *gorm.DB
}

// NewDatasetRepo 构造 repo。
func NewDatasetRepo(db *gorm.DB) *DatasetRepo {
	return &DatasetRepo{db: db}
}

// alive 统一附加未删除条件。所有查询都必须经过它，否则会读到已软删的数据。
func (r *DatasetRepo) alive() *gorm.DB {
	return r.db.Where("deleted_at = 0")
}

// Create 插入一条配置，唯一键冲突会被翻译成 ErrDuplicateKey。
func (r *DatasetRepo) Create(ctx context.Context, m *DatasetConfigModel) error {
	err := r.db.WithContext(ctx).Create(m).Error
	if err != nil {
		if isDuplicate(err) {
			return ErrDuplicateKey
		}
		return fmt.Errorf("create dataset: %w", err)
	}
	return nil
}

// GetByKey 按业务主键查询单条配置。
func (r *DatasetRepo) GetByKey(ctx context.Context, key string) (*DatasetConfigModel, error) {
	var m DatasetConfigModel
	err := r.alive().WithContext(ctx).Where("dataset_key = ?", key).Take(&m).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("get dataset: %w", err)
	}
	return &m, nil
}

// List 分页查询，keyword 同时匹配 key 与 name。
func (r *DatasetRepo) List(ctx context.Context, q model.ListQuery) ([]*DatasetConfigModel, int64, error) {
	query := r.alive().WithContext(ctx).Model(&DatasetConfigModel{})
	if kw := strings.TrimSpace(q.Keyword); kw != "" {
		like := "%" + escapeLike(kw) + "%"
		query = query.Where("dataset_key LIKE ? OR dataset_name LIKE ?", like, like)
	}
	if q.Status != nil {
		query = query.Where("status = ?", *q.Status)
	}

	var total int64
	if err := query.Count(&total).Error; err != nil {
		return nil, 0, fmt.Errorf("count dataset: %w", err)
	}
	if total == 0 {
		return []*DatasetConfigModel{}, 0, nil
	}

	var items []*DatasetConfigModel
	err := query.Order("updated_at DESC, id DESC").
		Offset((q.Page - 1) * q.Size).Limit(q.Size).
		Find(&items).Error
	if err != nil {
		return nil, 0, fmt.Errorf("list dataset: %w", err)
	}
	return items, total, nil
}

// ListAvailable 查询页使用的数据集列表：未删除，按更新时间倒序，最多 limit 条。
//
// 两点刻意的选择：
//  1. 不做分页、也不在 SQL 侧过滤租户：可见性规则放在 Go 里判断（见 model.ACL.Allows）。
//     后续还要往 acl 里加 users / roles 等维度，规则集中在一处才不会 SQL 与 Go 各写一遍。
//     代价是配置表要保持在千行量级——对「数据集配置」完全够用。
//  2. 不按 status 过滤。停用的数据集是否该从查询页消失是另一个决策，
//     这次只加租户管控，不动原有行为。
func (r *DatasetRepo) ListAvailable(ctx context.Context, limit int) ([]*DatasetConfigModel, error) {
	if limit <= 0 {
		limit = 200
	}
	var items []*DatasetConfigModel
	err := r.alive().WithContext(ctx).
		Order("updated_at DESC, id DESC").
		Limit(limit).
		Find(&items).Error
	if err != nil {
		return nil, fmt.Errorf("list available dataset: %w", err)
	}
	return items, nil
}

// Update 带乐观锁的更新。expectedVersion 不匹配时返回 ErrVersionConflict，
// 保证两个人同时编辑同一条配置时不会静默互相覆盖。
func (r *DatasetRepo) Update(ctx context.Context, m *DatasetConfigModel, expectedVersion int) error {
	m.Version = expectedVersion + 1
	res := r.db.WithContext(ctx).Model(&DatasetConfigModel{}).
		Where("dataset_key = ? AND deleted_at = 0 AND version = ?", m.DatasetKey, expectedVersion).
		Select("dataset_name", "mid_sql", "dim_map", "mtx_map", "label_map", "acl", "status", "version", "updated_by", "updated_at").
		Updates(m)
	if res.Error != nil {
		if isDuplicate(res.Error) {
			return ErrDuplicateKey
		}
		return fmt.Errorf("update dataset: %w", res.Error)
	}
	if res.RowsAffected == 0 {
		// 区分「不存在」与「版本冲突」，让前端能给出准确的提示。
		if _, err := r.GetByKey(ctx, m.DatasetKey); err != nil {
			return err
		}
		return ErrVersionConflict
	}
	return nil
}

// SoftDelete 软删除。deleted_at 写入毫秒时间戳，
// 配合联合唯一键 (dataset_key, deleted_at) 使同名 key 可以被反复删除重建。
func (r *DatasetRepo) SoftDelete(ctx context.Context, key string, at int64) error {
	res := r.db.WithContext(ctx).Model(&DatasetConfigModel{}).
		Where("dataset_key = ? AND deleted_at = 0", key).
		Update("deleted_at", at)
	if res.Error != nil {
		return fmt.Errorf("delete dataset: %w", res.Error)
	}
	if res.RowsAffected == 0 {
		return ErrNotFound
	}
	return nil
}

// isDuplicate 识别 MySQL 唯一键冲突。
// GORM 开启 TranslateError 后，1062 会被翻译成 gorm.ErrDuplicatedKey（"duplicated key not allowed"），
// 原始错误码字符串不再出现，因此必须以 errors.Is 判断为主，字符串匹配只作兜底。
func isDuplicate(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, gorm.ErrDuplicatedKey) {
		return true
	}
	msg := err.Error()
	return strings.Contains(msg, "1062") || strings.Contains(msg, "Duplicate entry")
}

// escapeLike 转义 LIKE 通配符，防止用户输入 % 或 _ 导致全表匹配。
func escapeLike(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, "%", `\%`)
	s = strings.ReplaceAll(s, "_", `\_`)
	return s
}
