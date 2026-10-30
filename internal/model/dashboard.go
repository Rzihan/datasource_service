package model

import "time"

// 面板的呈现形态。刻意只留五种：
// 多一种类型，作者就要多理解一次「条形图和柱状图有什么区别」，
// 而看板上的收益几乎为零——能回答问题的图，永远比图种类多更重要。
const (
	PanelViewTable  = "table"
	PanelViewMetric = "metric"
	PanelViewLine   = "line"
	PanelViewColumn = "column"
	PanelViewPie    = "pie"
)

// DashboardPanel 大盘里的一个面板。
//
// 面板是「一次可视化查询 + 怎么呈现它」的组合，不是图表配置：
// 数据怎么算由 dataset + query 决定（与查询页共用同一套解析），
// 面板只多回答两件事——画成什么、占多大地方。
type DashboardPanel struct {
	// ID 面板内唯一，前端用它做 React key 与「哪个面板正在编辑」。
	// 作者不填时由后端按 p1、p2 补：让「我删了一个面板」不会把别的面板的
	// 编辑状态带歪（用数组下标当身份时，删除会让后面的面板集体错位）。
	ID string `json:"id"`
	// Title 面板标题。可以为空，此时前端用「数据集 + 指标」兜底，
	// 但空标题的大盘一眼看过去全是同一个句式，所以编辑时提示必填。
	Title string `json:"title"`
	// Note 这一块在说什么 / 口径。看板上最贵的不是画图，是让人相信这个数。
	Note string `json:"note,omitempty"`
	// Dataset 数据集 key。必填——没有数据集的面板永远跑不出数，
	// 在大盘上就是一个永远转圈的方块。
	Dataset string `json:"dataset"`
	// Query 查询串，就是查询页 URL 里 ds 之后的那一段。
	// 与收藏 / 预置分析 / 入口默认视图共用同一种表示，
	// 于是「在查询页调好的那一屏」可以直接搬进大盘，不需要翻译。
	Query string `json:"query,omitempty"`
	// View 呈现形态，见上面的常量。
	View string `json:"view"`
	// Span 占 12 栅格中的几列。
	Span int `json:"span"`
	// Height 面板高度（px）。给高度而不是让它自适应：
	// 大盘要能一眼扫完，高度不齐会让视觉在页面上乱跳。
	Height int `json:"height"`
	// Metric 指标卡形态下取哪一列做主数字。
	// 多指标查询配指标卡时没有这个字段就只能瞎猜第一个，
	// 而「猜」在看板上意味着作者看到的主数字跟自己想的不一样。
	Metric string `json:"metric,omitempty"`
	// Follow 是否跟随大盘级筛选。用指针而不是 bool：
	// 「没说」和「说了不跟随」必须是两件事，否则一上线就会把
	// 所有存量面板默认成不跟随，整屏筛选看起来像坏了。
	Follow *bool `json:"follow,omitempty"`
	// EmitFilter 点这个面板的图形时，把哪个字段下钻成整屏筛选。
	// 作者不声明就用面板的第一个维度——那是「这一块在按什么分」最直接的答案。
	EmitFilter string `json:"emit_filter,omitempty"`
}

// DashboardPanelFilter 大盘级筛选器的声明（v32 起生效）。
//
// 与面板里的过滤条件不同：这一层是「整屏都要按它收窄」，
// 面板可以声明自己不跟随（比如「大盘整体趋势」不该被某个团队筛掉）。
type DashboardPanelFilter struct {
	// Field 字段名。必须是跟随面板的数据集里真实存在的字段，
	// 否则这个筛选器永远不生效，而界面上看不出来。
	Field string `json:"field"`
	// Label 展示名，常驻在大盘顶部。
	Label string `json:"label"`
	// Dataset 取值来源的数据集：候选值要从真实数据里取，
	// 手敲的候选值会跟数据脱节（拼写、新增值都不会同步）。
	Dataset string `json:"dataset,omitempty"`
	// Default 默认值。大盘打开就带着一个范围，比让人先填三个框再看到数好。
	Default string `json:"default,omitempty"`
}

// Dashboard 一张大盘，对应表 tb_dashboard。
//
// 它没有挂在任何数据集的 meta 上，是一等公民：一张大盘天然跨数据集
// （上面是采集的几条趋势，下面是质检的明细），把它塞进某个数据集的
// 说明书里，等于规定「这屏东西属于那一张表」——既不对，也会在数据集
// 改名/删除时跟着一起没。
type Dashboard struct {
	ID     uint64 `json:"id" gorm:"column:id;primaryKey;autoIncrement"`
	Key    string `json:"key" gorm:"column:dashboard_key;type:varchar(64);not null"`
	Title  string `json:"title" gorm:"column:title;type:varchar(128);not null"`
	Module string `json:"module" gorm:"column:module;type:varchar(64);not null;default:''"`
	Desc   string `json:"desc" gorm:"column:descr;type:varchar(512);not null;default:''"`
	Owner  string `json:"owner" gorm:"column:owner;type:varchar(64);not null;default:''"`
	Legacy string `json:"legacy" gorm:"column:legacy;type:varchar(64);not null;default:''"`
	// Status 迁移状态，取值与入口（DatasetEntry）完全一致：
	// 大盘与查询入口是同一场迁移里的两种目标，状态机必须共用一套，
	// 否则会出现「旧页已下线、但大盘还停在并存期」这种半吊子状态。
	Status    string                 `json:"status" gorm:"column:status;type:varchar(16);not null;default:'parallel'"`
	Panels    []DashboardPanel       `json:"panels" gorm:"column:panels;type:json;serializer:json;not null"`
	Filters   []DashboardPanelFilter `json:"filters" gorm:"column:filters;type:json;serializer:json;not null"`
	Version   int                    `json:"version" gorm:"column:version;type:int;not null;default:0"`
	CreatedBy string                 `json:"created_by" gorm:"column:created_by;type:varchar(64);not null;default:''"`
	UpdatedBy string                 `json:"updated_by" gorm:"column:updated_by;type:varchar(64);not null;default:''"`
	CreatedAt time.Time              `json:"created_at" gorm:"column:created_at;type:datetime(3);not null;autoCreateTime"`
	UpdatedAt time.Time              `json:"updated_at" gorm:"column:updated_at;type:datetime(3);not null;autoUpdateTime"`
	DeletedAt int64                  `json:"-" gorm:"column:deleted_at;type:bigint;not null;default:0"`
}

// TableName 指定表名。
func (Dashboard) TableName() string {
	return "tb_dashboard"
}

// DashboardCreateRequest 新建大盘。
type DashboardCreateRequest struct {
	Key     string                 `json:"key"`
	Title   string                 `json:"title"`
	Module  string                 `json:"module"`
	Desc    string                 `json:"desc"`
	Owner   string                 `json:"owner"`
	Legacy  string                 `json:"legacy"`
	Status  string                 `json:"status"`
	Panels  []DashboardPanel       `json:"panels"`
	Filters []DashboardPanelFilter `json:"filters"`
}

// DashboardUpdateRequest 更新大盘，Version 用于乐观锁。
// Key 不可改：它进 URL，改了等于把所有分享出去的链接一次性作废。
// 这里的字段全是指针/切片，语义是「不传 = 不动」——
// 前端只改布局时不应该顺手把说明清掉。
type DashboardUpdateRequest struct {
	Title   *string                `json:"title"`
	Module  *string                `json:"module"`
	Desc    *string                `json:"desc"`
	Owner   *string                `json:"owner"`
	Legacy  *string                `json:"legacy"`
	Status  *string                `json:"status"`
	Panels  []DashboardPanel       `json:"panels"`
	Filters []DashboardPanelFilter `json:"filters"`
	Version int                    `json:"version"`
}
