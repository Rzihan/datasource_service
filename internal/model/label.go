package model

import "time"

// GlobalLabel 是全局字段名称定义，对应表 tb_global_label。
//
// 它是一份「字段名 → 中文名」的字典，对所有数据集生效；数据集自己的
// DatasetConfig.LabelMap 退化为覆盖层，优先级更高。合并规则见 query 包的
// resolveLabel。这里刻意与 DatasetConfig 保持同款结构（软删 + 乐观锁），
// 少一套心智负担。
type GlobalLabel struct {
	ID       uint64 `json:"id" gorm:"column:id;primaryKey;autoIncrement"`
	FieldKey string `json:"field_key" gorm:"column:field_key;type:varchar(64);not null"`
	Label    string `json:"label" gorm:"column:label;type:varchar(128);not null"`
	// Status 停用的定义等同于不存在：查询页不再继承它的中文名。
	// 之所以不做硬删除，是为了保留「这个字段曾经叫什么」的痕迹，也避免误删后无从恢复。
	Status    int8      `json:"status" gorm:"column:status;type:tinyint;not null;default:1"`
	Version   int       `json:"version" gorm:"column:version;type:int;not null;default:0"`
	CreatedBy string    `json:"created_by" gorm:"column:created_by;type:varchar(64);not null;default:''"`
	UpdatedBy string    `json:"updated_by" gorm:"column:updated_by;type:varchar(64);not null;default:''"`
	CreatedAt time.Time `json:"created_at" gorm:"column:created_at;type:datetime(3);not null;autoCreateTime"`
	UpdatedAt time.Time `json:"updated_at" gorm:"column:updated_at;type:datetime(3);not null;autoUpdateTime"`
	DeletedAt int64     `json:"-" gorm:"column:deleted_at;type:bigint;not null;default:0"`
}

// TableName 指定表名。
func (GlobalLabel) TableName() string {
	return "tb_global_label"
}

// GlobalLabelCreateRequest 新建全局定义的请求体。
type GlobalLabelCreateRequest struct {
	FieldKey string `json:"field_key"`
	Label    string `json:"label"`
	Status   *int8  `json:"status"`
}

// GlobalLabelUpdateRequest 更新请求体，Version 用于乐观锁。
// FieldKey 不可改：改名等价于「删一条 + 建一条」，允许原地改会让引用它的数据集
// 在不知情的情况下换名字，因此这里只放开 Label 与 Status。
type GlobalLabelUpdateRequest struct {
	Label   string `json:"label"`
	Status  *int8  `json:"status"`
	Version int    `json:"version"`
}

// GlobalLabelListQuery 列表查询参数。
type GlobalLabelListQuery struct {
	Keyword string // 匹配 field_key / label
	Status  *int8
	Page    int
	Size    int
}

// GlobalLabelListResult 列表分页结果。
type GlobalLabelListResult struct {
	Items []*GlobalLabel `json:"items"`
	Total int64          `json:"total"`
	Page  int            `json:"page"`
	Size  int            `json:"size"`
}
