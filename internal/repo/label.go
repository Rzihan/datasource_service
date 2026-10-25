package repo

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"dataset_service/internal/model"

	"gorm.io/gorm"
)

// 全局定义的领域错误。刻意与数据集的错误分开定义：
// 「dataset not found」这类文案出现在字段名称接口上会让人摸不着头脑。
var (
	ErrLabelNotFound        = errors.New("label not found")
	ErrLabelDuplicateKey    = errors.New("field_key already exists")
	ErrLabelVersionConflict = errors.New("version conflict, please reload and retry")
)

// GlobalLabelModel 是 repo 层使用的实体别名。
type GlobalLabelModel = model.GlobalLabel

// LabelRepo 全局字段名称定义的数据访问层。
type LabelRepo struct {
	db *gorm.DB
}

// NewLabelRepo 构造 repo。
func NewLabelRepo(db *gorm.DB) *LabelRepo {
	return &LabelRepo{db: db}
}

// labelAlive 统一附加未删除条件。
func (r *LabelRepo) labelAlive() *gorm.DB {
	return r.db.Where("deleted_at = 0")
}

// Create 插入一条定义，唯一键冲突翻译为 ErrLabelDuplicateKey。
func (r *LabelRepo) Create(ctx context.Context, m *GlobalLabelModel) error {
	err := r.db.WithContext(ctx).Create(m).Error
	if err != nil {
		if isDuplicate(err) {
			return ErrLabelDuplicateKey
		}
		return fmt.Errorf("create label: %w", err)
	}
	return nil
}

// GetByKey 按字段名查询单条定义。
func (r *LabelRepo) GetByKey(ctx context.Context, key string) (*GlobalLabelModel, error) {
	var m GlobalLabelModel
	err := r.labelAlive().WithContext(ctx).Where("field_key = ?", key).Take(&m).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrLabelNotFound
		}
		return nil, fmt.Errorf("get label: %w", err)
	}
	return &m, nil
}

// List 分页查询，keyword 同时匹配字段名与中文名。
func (r *LabelRepo) List(ctx context.Context, q model.GlobalLabelListQuery) ([]*GlobalLabelModel, int64, error) {
	query := r.labelAlive().WithContext(ctx).Model(&GlobalLabelModel{})
	if kw := strings.TrimSpace(q.Keyword); kw != "" {
		like := "%" + escapeLike(kw) + "%"
		query = query.Where("field_key LIKE ? OR label LIKE ?", like, like)
	}
	if q.Status != nil {
		query = query.Where("status = ?", *q.Status)
	}

	var total int64
	if err := query.Count(&total).Error; err != nil {
		return nil, 0, fmt.Errorf("count label: %w", err)
	}
	if total == 0 {
		return []*GlobalLabelModel{}, 0, nil
	}

	var items []*GlobalLabelModel
	err := query.Order("updated_at DESC, id DESC").
		Offset((q.Page - 1) * q.Size).Limit(q.Size).
		Find(&items).Error
	if err != nil {
		return nil, 0, fmt.Errorf("list label: %w", err)
	}
	return items, total, nil
}

// ListEnabled 返回所有「未删除且启用」的定义，供进程内缓存全量加载。
//
// 不分页：这是字典表，量级在千行以内，全量加载比分页拼装简单得多，
// 也避免缓存里出现「只缓存了第一页」这种半截状态。
func (r *LabelRepo) ListEnabled(ctx context.Context, limit int) ([]*GlobalLabelModel, error) {
	if limit <= 0 {
		limit = 5000
	}
	var items []*GlobalLabelModel
	err := r.labelAlive().WithContext(ctx).
		Where("status = ?", model.StatusEnabled).
		Order("field_key ASC").
		Limit(limit).
		Find(&items).Error
	if err != nil {
		return nil, fmt.Errorf("list enabled label: %w", err)
	}
	return items, nil
}

// Update 带乐观锁的更新。
func (r *LabelRepo) Update(ctx context.Context, m *GlobalLabelModel, expectedVersion int) error {
	m.Version = expectedVersion + 1
	res := r.db.WithContext(ctx).Model(&GlobalLabelModel{}).
		Where("field_key = ? AND deleted_at = 0 AND version = ?", m.FieldKey, expectedVersion).
		Select("label", "status", "version", "updated_by", "updated_at").
		Updates(m)
	if res.Error != nil {
		if isDuplicate(res.Error) {
			return ErrLabelDuplicateKey
		}
		return fmt.Errorf("update label: %w", res.Error)
	}
	if res.RowsAffected == 0 {
		if _, err := r.GetByKey(ctx, m.FieldKey); err != nil {
			return err
		}
		return ErrLabelVersionConflict
	}
	return nil
}

// SoftDelete 软删除。
func (r *LabelRepo) SoftDelete(ctx context.Context, key string, at int64) error {
	res := r.db.WithContext(ctx).Model(&GlobalLabelModel{}).
		Where("field_key = ? AND deleted_at = 0", key).
		Update("deleted_at", at)
	if res.Error != nil {
		return fmt.Errorf("delete label: %w", res.Error)
	}
	if res.RowsAffected == 0 {
		return ErrLabelNotFound
	}
	return nil
}
