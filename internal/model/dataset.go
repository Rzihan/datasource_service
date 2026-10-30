package model

import (
	"time"
)

// Status 枚举：配置启用状态。
const (
	StatusDisabled int8 = 0
	StatusEnabled  int8 = 1
)

// ACL 数据集级访问控制，存在 JSON 列 acl 里：
//
//	{"tenants": ["t1","t2"], "col_tenants": {"stat_date": ["t1"], "cost": ["t1","t2"]}}
//
// 用 JSON 对象而不是纯数组，是为了扩展：再加 users / roles / 读写分离等维度时，
// 往对象里加字段即可，不用改表结构、不用迁存量数据。
//
// 两级白名单：
//   - Tenants：数据集级。空 = 不限制；非空 = 有交集才可见。
//   - ColTenants：列级。key 是 dim_map / mtx_map 的键（即查询页里看到的维度/指标名），
//     没配的列默认可见，配了的列有交集才可见。
type ACL struct {
	Tenants    []string            `json:"tenants,omitempty"`
	ColTenants map[string][]string `json:"col_tenants,omitempty"`
	RowFilter  RowFilter           `json:"row_filter"`
}

// RowFilter 行级权限过滤。两类规则各自独立开关：
//   - Tenant：把当前登录态的租户列表挂在指定列上
//   - User：把当前登录态的可见用户列表挂在指定列上
//
// 条件由服务端合成后追加到 WHERE（聚合前），客户端无法绕过。
// 开启但登录态对应列表为空时，语义是「一行都不匹配」——权限配置宁可拒，不可放。
type RowFilter struct {
	Tenant RowRule `json:"tenant"`
	User   RowRule `json:"user"`
}

// RowRule 单条行级规则。Column 是 dim_map 的键，由服务端换成真正的列表达式。
type RowRule struct {
	Enabled bool   `json:"enabled"`
	Column  string `json:"column,omitempty"`
}

// Allows 判断给定的登录态租户能否看到该数据集。
// 空白名单 = 公开，包括登录态没有任何租户的情况。
func (a ACL) Allows(tenants []string) bool {
	return intersects(a.Tenants, tenants)
}

// AllowsColumn 判断某个维度/指标列对当前登录态是否可见。
// 没配的列默认可见；配了但列表为空同样视为不限制；配了且非空则要有交集。
func (a ACL) AllowsColumn(col string, tenants []string) bool {
	if len(a.ColTenants) == 0 {
		return true
	}
	wl, ok := a.ColTenants[col]
	if !ok || len(wl) == 0 {
		return true
	}
	return intersects(wl, tenants)
}

// intersects 判断白名单与登录态租户是否有交集。空白名单表示不限制。
func intersects(whitelist, tenants []string) bool {
	if len(whitelist) == 0 {
		return true
	}
	for _, t := range tenants {
		for _, w := range whitelist {
			if t == w {
				return true
			}
		}
	}
	return false
}

// DatasetConfig 对应表 tb_dataset_config。
//
// 说明两个刻意的设计：
//  1. DeletedAt 用 int64 而非 GORM 内置的 gorm.DeletedAt。后者是 DATETIME NULL 语义，
//     而 MySQL 唯一索引中 NULL 之间互不冲突，多条 deleted_at IS NULL 的同名记录可以并存，
//     唯一约束会失效。这里用 "0 表示未删除，非 0 表示删除时刻毫秒时间戳"，
//     配合唯一索引 uk_dataset_key(dataset_key, deleted_at) 才能真正约束住。
//  2. DimMap / MtxMap 是 map[string]string，GORM 序列化为 JSON 列。
//     类型系统本身就是校验器：非字符串的值在反序列化时会被直接拒绝。
//
// DatasetMeta 数据集本身的「说明书」：谁维护、多久更新一次、每个字段什么口径。
//
// 刻意与 dim_map / mtx_map 分开存：
//   - 前者决定「能不能查」，后者决定「敢不敢用」。混在一起会让配置页
//     变成一坨，也会出现「为了补一句说明去改 SQL 配置」的荒唐操作。
//   - 它不参与 SQL 生成，写错最多是提示不准，不至于把查询改坏。
type DatasetMeta struct {
	// Description 一句话说明这个数据集适合回答什么问题
	Description string `json:"description,omitempty"`
	// Owner 负责人（找谁问口径）
	Owner string `json:"owner,omitempty"`
	// UpdateFreq 更新频率的人类可读描述，如「每日 06:00」
	UpdateFreq string `json:"update_freq,omitempty"`
	// Tags 业务标签，用于列表页筛选
	Tags []string `json:"tags,omitempty"`
	// FieldNotes key 是 dim_map / mtx_map 的键，值是口径说明（单位、计算公式、注意事项）
	FieldNotes map[string]string `json:"field_notes,omitempty"`
	// Examples 预置分析：数据集的作者把「这张表该怎么用」直接钉在看板上
	Examples []MetaExample `json:"examples,omitempty"`
	// DefaultExample 作者的默认视图：取值是某条 example 的 query。
	// 作者不该靠「堆十条预置分析」表达意图——那只是把选择成本转嫁给用户。
	// 指定一条默认，其余才是「可选项」。
	DefaultExample string `json:"default_example,omitempty"`
}

// MetaExample 一条预置分析。
//
// 用「查询参数串」而不是结构化字段，是刻意的：
//   - 查询页的状态本来就序列化在 URL 里，预置分析只是把那段串存下来，
//     打开时原样拼回 /query 即可，不需要另一套还原逻辑；
//   - 将来查询能力增加（新的操作符、对比周期……）预置分析自动支持，
//     不用改这里的数据结构。
//
// Query 形如 "dims=date&metrics=episodes&filter=%7B...%7D&limit=1000"，不含 ds。
type MetaExample struct {
	Title string `json:"title"`
	Note  string `json:"note,omitempty"`
	Query string `json:"query"`
}

type DatasetConfig struct {
	ID          uint64            `json:"id" gorm:"column:id;primaryKey;autoIncrement"`
	DatasetKey  string            `json:"dataset_key" gorm:"column:dataset_key;type:varchar(64);not null"`
	DatasetName string            `json:"dataset_name" gorm:"column:dataset_name;type:varchar(128);not null"`
	MidSQL      string            `json:"mid_sql" gorm:"column:mid_sql;type:mediumtext;not null"`
	DimMap      map[string]string `json:"dim_map" gorm:"column:dim_map;type:json;serializer:json;not null"`
	MtxMap      map[string]string `json:"mtx_map" gorm:"column:mtx_map;type:json;serializer:json;not null"`
	// MultiDimMap 多值维度：key 是维度名，value 是「产出数组」的表达式。
	//
	// 典型场景：一个人属于多个公司、一个订单打了多个标签。这类字段
	// 放进 GROUP BY 会按值拆成多行，而业务要看的恰恰是「一行里展示他属于哪几个」。
	// 所以它走的是另一条路：SELECT 里用聚合函数把多个取值收拢成一个展示值，
	// **并且不进 GROUP BY**。
	//
	// 之前只能把它塞进 mtx_map 当指标，语义是错的——它是维度，只是需要聚合。
	// 这里是第三种字段类型：出现在维度下拉、但生成聚合表达式。
	MultiDimMap map[string]string `json:"multi_dim_map" gorm:"column:multi_dim_map;type:json;serializer:json;not null"`
	// LabelMap 描述维度与指标的中文含义，key 是 dim_map / mtx_map 里的键。
	// 只影响展示（勾选控件、表头），不参与 SQL 生成。
	LabelMap map[string]string `json:"label_map" gorm:"column:label_map;type:json;serializer:json;not null"`
	// ACL 数据集级访问控制，查询页按登录态租户与白名单取交集来判断可见性。
	ACL ACL `json:"acl" gorm:"column:acl;type:json;serializer:json;not null"`
	// Meta 数据集说明书：描述 / 负责人 / 更新频率 / 字段口径 / 预置分析
	Meta      DatasetMeta `json:"meta" gorm:"column:meta;type:json;serializer:json;not null"`
	Status    int8        `json:"status" gorm:"column:status;type:tinyint;not null;default:1"`
	Version   int         `json:"version" gorm:"column:version;type:int;not null;default:0"`
	CreatedBy string      `json:"created_by" gorm:"column:created_by;type:varchar(64);not null;default:''"`
	UpdatedBy string      `json:"updated_by" gorm:"column:updated_by;type:varchar(64);not null;default:''"`
	CreatedAt time.Time   `json:"created_at" gorm:"column:created_at;type:datetime(3);not null;autoCreateTime"`
	UpdatedAt time.Time   `json:"updated_at" gorm:"column:updated_at;type:datetime(3);not null;autoUpdateTime"`
	DeletedAt int64       `json:"-" gorm:"column:deleted_at;type:bigint;not null;default:0"`
}

// TableName 指定表名。
func (DatasetConfig) TableName() string {
	return "tb_dataset_config"
}

// CreateRequest 新建配置的请求体。
type CreateRequest struct {
	DatasetKey  string            `json:"dataset_key"`
	DatasetName string            `json:"dataset_name"`
	MidSQL      string            `json:"mid_sql"`
	DimMap      map[string]string `json:"dim_map"`
	MultiDimMap map[string]string `json:"multi_dim_map"`
	MtxMap      map[string]string `json:"mtx_map"`
	LabelMap    map[string]string `json:"label_map"`
	ACL         ACL               `json:"acl"`
	// Meta 指针：不传 = 不修改。用值类型的话，老客户端（配置页保存）会把
	// 已有说明书整段清空——「没说」和「说没有」必须是两件事。
	Meta   *DatasetMeta `json:"meta,omitempty"`
	Status *int8        `json:"status"`
}

// UpdateRequest 更新配置的请求体，Version 用于乐观锁。
type UpdateRequest struct {
	DatasetName string            `json:"dataset_name"`
	MidSQL      string            `json:"mid_sql"`
	DimMap      map[string]string `json:"dim_map"`
	MultiDimMap map[string]string `json:"multi_dim_map"`
	MtxMap      map[string]string `json:"mtx_map"`
	LabelMap    map[string]string `json:"label_map"`
	ACL         ACL               `json:"acl"`
	Meta        *DatasetMeta      `json:"meta,omitempty"`
	Status      *int8             `json:"status"`
	Version     int               `json:"version"`
}

// ValidateRequest 只校验不落库的请求体，供前端实时校验使用。
type ValidateRequest struct {
	DimMap      map[string]string `json:"dim_map"`
	MultiDimMap map[string]string `json:"multi_dim_map"`
	MtxMap      map[string]string `json:"mtx_map"`
	LabelMap    map[string]string `json:"label_map"`
	ACL         ACL               `json:"acl"`
}

// 历史动作类型。
const (
	ActionCreate   = "create"
	ActionUpdate   = "update"
	ActionDelete   = "delete"
	ActionRollback = "rollback"
	// ActionMigrate 把字段从 dim_map / mtx_map 搬到 multi_dim_map。
	// 单独一个动作而不是复用 update：迁移是「纠错」，跟随手改配置不是一回事，
	// 翻历史时应该能一眼看出这条是因为多值维度改错了。
	ActionMigrate = "migrate"
)

// MultiDimCandidate 一个「疑似多值维度、但被配成了指标或普通维度」的字段。
type MultiDimCandidate struct {
	DatasetKey string `json:"dataset_key"`
	FieldKey   string `json:"field_key"`
	// From 标记它现在待在哪：mtx_map（当指标顶着）或 dim_map（会按取值拆行）
	From   string `json:"from"`
	Expr   string `json:"expr"`
	Reason string `json:"reason"`
	// SuggestExpr 建议搬进 multi_dim_map 的表达式。
	//
	// 不能直接用 Expr：以前多值维度只能塞进 mtx_map，写法就是完整收拢式
	// arrayStringConcat(arraySort(groupUniqArrayArray(companies)), ',')，
	// 原样搬过去生成 SQL 时会再包一层收拢，变成
	// groupUniqArrayArray(收拢后的字符串)，必然报错。所以要先剥壳。
	SuggestExpr string `json:"suggest_expr"`
	// Confident 表示能确认 SuggestExpr 真的产出数组（拿 mid_sql 的列类型验证过）。
	// 为 false 时前端不给一键迁移按钮，只提示人工改——猜错了比不迁更糟。
	Confident bool `json:"confident"`
}

// MultiDimMigrateItem 要搬的一个字段。Expr 由前端把扫描建议带回，
// 服务端不做猜测：它拿不到 mid_sql 的列类型，判断不了剥壳剥得对不对。
type MultiDimMigrateItem struct {
	Field string `json:"field"`
	Expr  string `json:"expr"`
}

// MultiDimCheckResult 多值维度误配扫描结果。
type MultiDimCheckResult struct {
	Candidates   []MultiDimCandidate `json:"candidates"`
	DatasetCount int                 `json:"dataset_count"`
	// Scanned 是真正拿到 mid_sql 列类型的数据集数。跑不通的会跳过——
	// 扫描是个辅助功能，不该因为某个数据集的 SQL 有问题就整个失败。
	Scanned int `json:"scanned"`
}

// MigrateMultiDimRequest 把若干字段搬进 multi_dim_map 的请求。
// Version 用于乐观锁：扫描到操作之间别人可能改过配置。
type MigrateMultiDimRequest struct {
	Items   []MultiDimMigrateItem `json:"items"`
	Version int                   `json:"version"`
}

// DatasetHistory 是数据集配置的一次变更快照，对应表 tb_dataset_config_history。
//
// 快照语义刻意统一为「这次操作完成后的配置状态」：
//   - create / update：操作后的新状态
//   - delete：删除前的最后状态（配置已不存在，只能记删除前）
//   - rollback：回滚完成后的状态
//
// 这样任何一条历史都能直接回滚到「那一刻」的样子，不用区分是前镜像还是后镜像。
type DatasetHistory struct {
	ID         uint64        `json:"id" gorm:"column:id;primaryKey;autoIncrement"`
	DatasetKey string        `json:"dataset_key" gorm:"column:dataset_key;type:varchar(64);not null"`
	Version    int           `json:"version" gorm:"column:version;type:int;not null;default:0"`
	Action     string        `json:"action" gorm:"column:action;type:varchar(16);not null"`
	Operator   string        `json:"operator" gorm:"column:operator;type:varchar(64);not null;default:''"`
	CreatedAt  time.Time     `json:"created_at" gorm:"column:created_at;type:datetime(3);not null;autoCreateTime"`
	Snapshot   DatasetConfig `json:"-" gorm:"column:snapshot;type:json;serializer:json;not null"`
}

// TableName 指定表名。
func (DatasetHistory) TableName() string {
	return "tb_dataset_config_history"
}

// HistoryResult 历史列表响应。Snapshot 不返回给前端：mid_sql 最长 1 MiB，
// 列表里带全量快照会把响应撑爆，回滚只需要 id。
type HistoryResult struct {
	Items []*DatasetHistory `json:"items"`
}

// RollbackRequest 回滚请求。
type RollbackRequest struct {
	HistoryID uint64 `json:"history_id"`
}

// ListQuery 列表查询参数。
type ListQuery struct {
	Keyword string // 匹配 dataset_key / dataset_name
	Status  *int8
	Page    int
	Size    int
}

// ListResult 列表分页结果。
type ListResult struct {
	Items []*DatasetConfig `json:"items"`
	Total int64            `json:"total"`
	Page  int              `json:"page"`
	Size  int              `json:"size"`
}
