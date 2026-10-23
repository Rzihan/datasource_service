package repo

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"datasource_service/internal/model"

	"gorm.io/gorm"
)

// 领域错误，由 handler 映射为 HTTP 状态码。
var (
	ErrNotFound        = errors.New("datasource not found")
	ErrDuplicateKey    = errors.New("datasource_key already exists")
	ErrVersionConflict = errors.New("version conflict, please reload and retry")
)

// DatasourceConfigModel 是 repo 层使用的实体别名，避免 repo 直接依赖 model 的 JSON 标签语义。
type DatasourceConfigModel = model.DatasourceConfig

// DatasourceRepo 配置表的数据访问层。
type DatasourceRepo struct {
	db *gorm.DB
}

// NewDatasourceRepo 构造 repo。
func NewDatasourceRepo(db *gorm.DB) *DatasourceRepo {
	return &DatasourceRepo{db: db}
}

// alive 统一附加未删除条件。所有查询都必须经过它，否则会读到已软删的数据。
func (r *DatasourceRepo) alive() *gorm.DB {
	return r.db.Where("deleted_at = 0")
}

// Create 插入一条配置，唯一键冲突会被翻译成 ErrDuplicateKey。
func (r *DatasourceRepo) Create(ctx context.Context, m *DatasourceConfigModel) error {
	err := r.db.WithContext(ctx).Create(m).Error
	if err != nil {
		if isDuplicate(err) {
			return ErrDuplicateKey
		}
		return fmt.Errorf("create datasource: %w", err)
	}
	return nil
}

// GetByKey 按业务主键查询单条配置。
func (r *DatasourceRepo) GetByKey(ctx context.Context, key string) (*DatasourceConfigModel, error) {
	var m DatasourceConfigModel
	err := r.alive().WithContext(ctx).Where("datasource_key = ?", key).Take(&m).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("get datasource: %w", err)
	}
	return &m, nil
}

// List 分页查询，keyword 同时匹配 key 与 name。
func (r *DatasourceRepo) List(ctx context.Context, q model.ListQuery) ([]*DatasourceConfigModel, int64, error) {
	query := r.alive().WithContext(ctx).Model(&DatasourceConfigModel{})
	if kw := strings.TrimSpace(q.Keyword); kw != "" {
		like := "%" + escapeLike(kw) + "%"
		query = query.Where("datasource_key LIKE ? OR datasource_name LIKE ?", like, like)
	}
	if q.Status != nil {
		query = query.Where("status = ?", *q.Status)
	}

	var total int64
	if err := query.Count(&total).Error; err != nil {
		return nil, 0, fmt.Errorf("count datasource: %w", err)
	}
	if total == 0 {
		return []*DatasourceConfigModel{}, 0, nil
	}

	var items []*DatasourceConfigModel
	err := query.Order("updated_at DESC, id DESC").
		Offset((q.Page - 1) * q.Size).Limit(q.Size).
		Find(&items).Error
	if err != nil {
		return nil, 0, fmt.Errorf("list datasource: %w", err)
	}
	return items, total, nil
}

// Update 带乐观锁的更新。expectedVersion 不匹配时返回 ErrVersionConflict，
// 保证两个人同时编辑同一条配置时不会静默互相覆盖。
func (r *DatasourceRepo) Update(ctx context.Context, m *DatasourceConfigModel, expectedVersion int) error {
	m.Version = expectedVersion + 1
	res := r.db.WithContext(ctx).Model(&DatasourceConfigModel{}).
		Where("datasource_key = ? AND deleted_at = 0 AND version = ?", m.DatasourceKey, expectedVersion).
		Select("datasource_name", "mid_sql", "dim_map", "mtx_map", "status", "version", "updated_by", "updated_at").
		Updates(m)
	if res.Error != nil {
		if isDuplicate(res.Error) {
			return ErrDuplicateKey
		}
		return fmt.Errorf("update datasource: %w", res.Error)
	}
	if res.RowsAffected == 0 {
		// 区分「不存在」与「版本冲突」，让前端能给出准确的提示。
		if _, err := r.GetByKey(ctx, m.DatasourceKey); err != nil {
			return err
		}
		return ErrVersionConflict
	}
	return nil
}

// SoftDelete 软删除。deleted_at 写入毫秒时间戳，
// 配合联合唯一键 (datasource_key, deleted_at) 使同名 key 可以被反复删除重建。
func (r *DatasourceRepo) SoftDelete(ctx context.Context, key string, at int64) error {
	res := r.db.WithContext(ctx).Model(&DatasourceConfigModel{}).
		Where("datasource_key = ? AND deleted_at = 0", key).
		Update("deleted_at", at)
	if res.Error != nil {
		return fmt.Errorf("delete datasource: %w", res.Error)
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
