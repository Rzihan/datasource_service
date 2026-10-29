package query

import "strings"

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

// 条件树的逻辑运算符。
const (
	LogicAnd = "and"
	LogicOr  = "or"
)

// FilterNode 过滤条件树的一个节点，二选一：
//
//   - 分组节点：Logic = and / or + Children
//   - 叶子节点：Field / Op / Value / Values
//
// 分组可以无限嵌套，这样「A AND (B OR C)」这类组合才表达得出来。
type FilterNode struct {
	Logic    string       `json:"logic,omitempty"`
	Children []FilterNode `json:"children,omitempty"`

	Field  string   `json:"field,omitempty"`
	Op     string   `json:"op,omitempty"`
	Value  string   `json:"value,omitempty"`
	Values []string `json:"values,omitempty"`
}

// IsGroup 判断是否为分组节点。
func (n FilterNode) IsGroup() bool {
	return strings.TrimSpace(n.Logic) != ""
}

// 条件树的规模上限。条件树是用户自由构造的递归结构，
// 不给上限的话一个深层嵌套就能让 SQL 组装和 ClickHouse 解析都变得很难受。
const (
	MaxFilterDepth = 5
	MaxFilterNodes = 64
)

// OrderBy 排序项。
type OrderBy struct {
	Field string `json:"field"`
	Desc  bool   `json:"desc"`
}

// ExecuteRequest 是「查询意图」，不是 SQL。
// 前端只描述想看什么，SQL 完全由后端生成，用户不感知 SQL 的存在。
type ExecuteRequest struct {
	DatasetKey string      `json:"dataset_key"`
	Dims       []string    `json:"dims"`
	Metrics    []string    `json:"metrics"`
	Filter     *FilterNode `json:"filter"`
	OrderBy    []OrderBy   `json:"order_by"`
	Limit      int         `json:"limit"`
}

// QueryDataset 是查询页看到的数据集。
// 刻意不含 mid_sql（用户不感知 SQL）与 acl（没必要把别人的租户名下发给浏览器）。
// dim_map / mtx_map 已按列级白名单过滤，看不到的列不会出现在下拉里。
type QueryDataset struct {
	DatasetKey  string            `json:"dataset_key"`
	DatasetName string            `json:"dataset_name"`
	DimMap      map[string]string `json:"dim_map"`
	// MultiDimMap 多值维度。前端要把它合并进维度下拉，
	// 但展示上给它一个「多值」标记——用户需要知道这一列是收拢展示的。
	MultiDimMap map[string]string `json:"multi_dim_map"`
	MtxMap      map[string]string `json:"mtx_map"`
	LabelMap    map[string]string `json:"label_map"`
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
