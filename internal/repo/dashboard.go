package repo

import (
	"context"
	"errors"
	"fmt"

	"dataset_service/internal/model"

	"gorm.io/gorm"
)

// 大盘的领域错误。与数据集分开定义：接口报「dataset not found」
// 会让人以为是数据集配错了，实际是大盘 key 写错了。
var (
	ErrDashboardNotFound        = errors.New("dashboard not found")
	ErrDashboardDuplicateKey    = errors.New("dashboard_key already exists")
	ErrDashboardVersionConflict = errors.New("version conflict, please reload and retry")
)

// DashboardModel 是 repo 层使用的实体别名。
type DashboardModel = model.Dashboard

// DashboardRepo 大盘的数据访问层。
type DashboardRepo struct {
	db *gorm.DB
}

// NewDashboardRepo 构造 repo。
func NewDashboardRepo(db *gorm.DB) *DashboardRepo {
	return &DashboardRepo{db: db}
}

func (r *DashboardRepo) alive() *gorm.DB {
	return r.db.Where("deleted_at = 0")
}

// Create 插入一条大盘，唯一键冲突翻译为 ErrDashboardDuplicateKey。
func (r *DashboardRepo) Create(ctx context.Context, m *DashboardModel) error {
	err := r.db.WithContext(ctx).Create(m).Error
	if err != nil {
		if isDuplicate(err) {
			return ErrDashboardDuplicateKey
		}
		return fmt.Errorf("create dashboard: %w", err)
	}
	return nil
}

// GetByKey 按 key 查询单条大盘。
func (r *DashboardRepo) GetByKey(ctx context.Context, key string) (*DashboardModel, error) {
	var m DashboardModel
	err := r.alive().WithContext(ctx).Where("dashboard_key = ?", key).Take(&m).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrDashboardNotFound
		}
		return nil, fmt.Errorf("get dashboard: %w", err)
	}
	return &m, nil
}

// ListAll 列出全部大盘。
//
// 不做分页：大盘是「几个页面」的量级，不是「几万行数据」。
// 分页在这里只会让菜单组装变成「翻页取全量」的怪事。
func (r *DashboardRepo) ListAll(ctx context.Context, limit int) ([]*DashboardModel, error) {
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	var items []*DashboardModel
	err := r.alive().WithContext(ctx).Order("updated_at DESC").Limit(limit).Find(&items).Error
	if err != nil {
		return nil, fmt.Errorf("list dashboards: %w", err)
	}
	return items, nil
}

// Update 全量更新（乐观锁）。version 不一致时 RowsAffected 为 0。
func (r *DashboardRepo) Update(ctx context.Context, key string, version int, patch map[string]interface{}) error {
	res := r.db.WithContext(ctx).Model(&DashboardModel{}).
		Where("dashboard_key = ? AND deleted_at = 0 AND version = ?", key, version).
		Updates(patch)
	if res.Error != nil {
		if isDuplicate(res.Error) {
			return ErrDashboardDuplicateKey
		}
		return fmt.Errorf("update dashboard: %w", res.Error)
	}
	if res.RowsAffected == 0 {
		// 分不清是「key 不存在」还是「版本冲突」，查一次给出准确的那个：
		// 两种情况的下一步动作完全不同（重新加载 vs 根本没这个大盘）。
		if _, err := r.GetByKey(ctx, key); err != nil {
			return err
		}
		return ErrDashboardVersionConflict
	}
	return nil
}

// Delete 软删。与数据集同款：大盘挂在菜单上，误删之后至少要能查到它曾经存在。
func (r *DashboardRepo) Delete(ctx context.Context, key string, at int64) error {
	res := r.db.WithContext(ctx).Model(&DashboardModel{}).
		Where("dashboard_key = ? AND deleted_at = 0", key).
		Update("deleted_at", at)
	if res.Error != nil {
		return fmt.Errorf("delete dashboard: %w", res.Error)
	}
	if res.RowsAffected == 0 {
		return ErrDashboardNotFound
	}
	return nil
}
