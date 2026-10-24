package query

// 允许的比较操作符白名单。过滤值一律走 ClickHouse 命名参数绑定，
// 绝不做字符串拼接——这是整个查询功能唯一的注入面，必须堵死。
const (
	OpEq    = "="
	OpNe    = "!="
	OpGt    = ">"
	OpGte   = ">="
	OpLt    = "<"
	OpLte   = "<="
	OpLike  = "like"
	OpIn    = "in"
	OpNotIn = "not in"
)

var allowedOps = map[string]bool{
	OpEq: true, OpNe: true, OpGt: true, OpGte: true, OpLt: true, OpLte: true,
	OpLike: true, OpIn: true, OpNotIn: true,
}

// metricOps 是作用在指标（HAVING）上时允许的操作符。
// 指标是聚合结果，绝大多数是数值，like 这类字符串匹配没有语义，
// 与其让 ClickHouse 抛晦涩的类型错误，不如在这里就拒绝并说清楚。
var metricOps = map[string]bool{
	OpEq: true, OpNe: true, OpGt: true, OpGte: true, OpLt: true, OpLte: true,
	OpIn: true, OpNotIn: true,
}

// Filter 单个过滤条件。Value 用于单值比较，Values 用于 in / not in。
type Filter struct {
	Field  string   `json:"field"`
	Op     string   `json:"op"`
	Value  string   `json:"value"`
	Values []string `json:"values"`
}

// OrderBy 排序项。
type OrderBy struct {
	Field string `json:"field"`
	Desc  bool   `json:"desc"`
}

// ExecuteRequest 是「查询意图」，不是 SQL。
// 前端只描述想看什么，SQL 完全由后端生成，用户不感知 SQL 的存在。
type ExecuteRequest struct {
	DatasourceKey string    `json:"datasource_key"`
	Dims          []string  `json:"dims"`
	Metrics       []string  `json:"metrics"`
	Filters       []Filter  `json:"filters"`
	OrderBy       []OrderBy `json:"order_by"`
	Limit         int       `json:"limit"`
}

// Column 结果列元信息。
type Column struct {
	Name string `json:"name"`
	Type string `json:"type"`
}

// ExecuteResult 查询结果。
type ExecuteResult struct {
	Columns   []Column `json:"columns"`
	Rows      [][]any  `json:"rows"`
	RowCount  int      `json:"row_count"`
	ElapsedMs int64    `json:"elapsed_ms"`
	Truncated bool     `json:"truncated"`
}
