package model

import (
	"time"
)

// Status 枚举：配置启用状态。
const (
	StatusDisabled int8 = 0
	StatusEnabled  int8 = 1
)

// ACL 数据源级访问控制，存在 JSON 列 acl 里。
//
// 用 JSON 对象而不是纯数组，是为了后续扩展：再加 users / roles / 读写分离等维度时，
// 往对象里加字段即可，不用改表结构、不用迁存量数据。
//
// 语义：Tenants 为空表示不限制（所有租户可见）；非空表示只有与登录态租户存在交集才可见。
type ACL struct {
	Tenants []string `json:"tenants,omitempty"`
}

// Allows 判断给定的登录态租户能否看到该数据源。
// 空白名单 = 公开，包括登录态没有任何租户的情况。
func (a ACL) Allows(tenants []string) bool {
	if len(a.Tenants) == 0 {
		return true
	}
	for _, t := range tenants {
		for _, w := range a.Tenants {
			if t == w {
				return true
			}
		}
	}
	return false
}

// DatasourceConfig 对应表 datasource_config。
//
// 说明两个刻意的设计：
//  1. DeletedAt 用 int64 而非 GORM 内置的 gorm.DeletedAt。后者是 DATETIME NULL 语义，
//     而 MySQL 唯一索引中 NULL 之间互不冲突，多条 deleted_at IS NULL 的同名记录可以并存，
//     唯一约束会失效。这里用 "0 表示未删除，非 0 表示删除时刻毫秒时间戳"，
//     配合唯一索引 uk_datasource_key(datasource_key, deleted_at) 才能真正约束住。
//  2. DimMap / MtxMap 是 map[string]string，GORM 序列化为 JSON 列。
//     类型系统本身就是校验器：非字符串的值在反序列化时会被直接拒绝。
type DatasourceConfig struct {
	ID             uint64            `json:"id" gorm:"column:id;primaryKey;autoIncrement"`
	DatasourceKey  string            `json:"datasource_key" gorm:"column:datasource_key;type:varchar(64);not null"`
	DatasourceName string            `json:"datasource_name" gorm:"column:datasource_name;type:varchar(128);not null"`
	MidSQL         string            `json:"mid_sql" gorm:"column:mid_sql;type:mediumtext;not null"`
	DimMap         map[string]string `json:"dim_map" gorm:"column:dim_map;type:json;serializer:json;not null"`
	MtxMap         map[string]string `json:"mtx_map" gorm:"column:mtx_map;type:json;serializer:json;not null"`
	// LabelMap 描述维度与指标的中文含义，key 是 dim_map / mtx_map 里的键。
	// 只影响展示（勾选控件、表头），不参与 SQL 生成。
	LabelMap map[string]string `json:"label_map" gorm:"column:label_map;type:json;serializer:json;not null"`
	// ACL 数据源级访问控制，查询页按登录态租户与白名单取交集来判断可见性。
	ACL       ACL       `json:"acl" gorm:"column:acl;type:json;serializer:json;not null"`
	Status    int8      `json:"status" gorm:"column:status;type:tinyint;not null;default:1"`
	Version   int       `json:"version" gorm:"column:version;type:int;not null;default:0"`
	CreatedBy string    `json:"created_by" gorm:"column:created_by;type:varchar(64);not null;default:''"`
	UpdatedBy string    `json:"updated_by" gorm:"column:updated_by;type:varchar(64);not null;default:''"`
	CreatedAt time.Time `json:"created_at" gorm:"column:created_at;type:datetime(3);not null;autoCreateTime"`
	UpdatedAt time.Time `json:"updated_at" gorm:"column:updated_at;type:datetime(3);not null;autoUpdateTime"`
	DeletedAt int64     `json:"-" gorm:"column:deleted_at;type:bigint;not null;default:0"`
}

// TableName 指定表名。
func (DatasourceConfig) TableName() string {
	return "datasource_config"
}

// CreateRequest 新建配置的请求体。
type CreateRequest struct {
	DatasourceKey  string            `json:"datasource_key"`
	DatasourceName string            `json:"datasource_name"`
	MidSQL         string            `json:"mid_sql"`
	DimMap         map[string]string `json:"dim_map"`
	MtxMap         map[string]string `json:"mtx_map"`
	LabelMap       map[string]string `json:"label_map"`
	ACL            ACL               `json:"acl"`
	Status         *int8             `json:"status"`
}

// UpdateRequest 更新配置的请求体，Version 用于乐观锁。
type UpdateRequest struct {
	DatasourceName string            `json:"datasource_name"`
	MidSQL         string            `json:"mid_sql"`
	DimMap         map[string]string `json:"dim_map"`
	MtxMap         map[string]string `json:"mtx_map"`
	LabelMap       map[string]string `json:"label_map"`
	ACL            ACL               `json:"acl"`
	Status         *int8             `json:"status"`
	Version        int               `json:"version"`
}

// ValidateRequest 只校验不落库的请求体，供前端实时校验使用。
type ValidateRequest struct {
	DimMap   map[string]string `json:"dim_map"`
	MtxMap   map[string]string `json:"mtx_map"`
	LabelMap map[string]string `json:"label_map"`
	ACL      ACL               `json:"acl"`
}

// ListQuery 列表查询参数。
type ListQuery struct {
	Keyword string // 匹配 datasource_key / datasource_name
	Status  *int8
	Page    int
	Size    int
}

// ListResult 列表分页结果。
type ListResult struct {
	Items []*DatasourceConfig `json:"items"`
	Total int64               `json:"total"`
	Page  int                 `json:"page"`
	Size  int                 `json:"size"`
}
