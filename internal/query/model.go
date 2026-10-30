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
	// 多值维度专用：判断数组列是否包含某些值。
	// 不复用 = / in —— 数组列的「相等」没有直观语义，
	// 用 has 系列把「包含 / 包含任一 / 包含全部」说清楚。
	OpHas    = "has"
	OpHasNot = "has_not"
	OpHasAny = "has_any"
	OpHasAll = "has_all"
	// 空值判断。可空维度里 NULL 是一类真实数据（未归因流量），
	// 没有这两个操作符时用户既筛不掉它、也单独看不出来，做占比分母还含着它。
	OpIsNull    = "is_null"
	OpIsNotNull = "is_not_null"
)

var allowedOps = map[string]bool{
	OpEq: true, OpNe: true, OpGt: true, OpGte: true, OpLt: true, OpLte: true,
	OpLike: true, OpIn: true, OpNotIn: true,
	OpHas: true, OpHasNot: true, OpHasAny: true, OpHasAll: true,
	OpIsNull: true, OpIsNotNull: true,
}

// nullOps 不需要右值，编译成 IS NULL / IS NOT NULL。
var nullOps = map[string]bool{OpIsNull: true, OpIsNotNull: true}

// metricOps 是作用在指标（HAVING）上时允许的操作符。
// 指标是聚合结果，绝大多数是数值，like 这类字符串匹配没有语义，
// 与其让 ClickHouse 抛晦涩的类型错误，不如在这里就拒绝并说清楚。
var metricOps = map[string]bool{
	OpEq: true, OpNe: true, OpGt: true, OpGte: true, OpLt: true, OpLte: true,
	OpIn: true, OpNotIn: true,
}

// multiDimOps 是多值维度允许的操作符，只有 has 系列。
// 数组列上 = / like / in 都没有直觉语义，硬跑要么报错要么给出意外结果。
var multiDimOps = map[string]bool{
	OpHas: true, OpHasNot: true, OpHasAny: true, OpHasAll: true,
}

// multiDimArrayOps 需要值列表（而不是单个值）的多值维度操作符。
var multiDimArrayOps = map[string]bool{
	OpHasAny: true, OpHasAll: true,
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

// 对比周期的两种口径。
//   - PrevPeriod：上一个等长周期（近 7 天 vs 再往前 7 天）——周报最常用
//   - PrevYear：去年同期（近 30 天 vs 去年这 30 天）——季节性业务用
//
// 不做「上月同期」：月份长度不固定，怎么对齐都有争议，不如让用户自己选区间。
const (
	ComparePrevPeriod = "prev_period"
	ComparePrevYear   = "prev_year"
)

// Compare 对比周期。Field 必须是普通日期维度（dim_map 的键），
// 多值维度是数组，没有「区间」的概念。
type Compare struct {
	Mode  string `json:"mode"`
	Field string `json:"field"`
}

// CompareMeta 对比结果的口径与对齐后的上期值。
//
// 上期值用「与 rows 一一对应的数组」返回，而不是往主表里插列：
//   - 主表的列名/列序保持不变，前端所有既有逻辑（排序、合计、导出、图表）不用改；
//   - 上期可能多出本期没有的维度组合（客户上月有交付、这个月没有），
//     这些行会被补到末尾，Base 侧为 NULL，Frontend 需要知道补了几行。
type CompareMeta struct {
	Mode     string `json:"mode"`
	Field    string `json:"field"`
	BaseFrom string `json:"base_from"`
	BaseTo   string `json:"base_to"`
	PrevFrom string `json:"prev_from"`
	PrevTo   string `json:"prev_to"`
	// PrevValues[metric][rowIndex]，与 Rows 对齐。对不上的位置为 nil。
	PrevValues map[string][]any `json:"prev_values"`
	// AddedRows 上期有、本期没有的维度组合数（这些行已补在 Rows 末尾，本期指标为 NULL）
	AddedRows int `json:"added_rows"`
	// BaseInferred 本期区间是探测出来的（用户没设时间范围），而不是用户显式给的
	BaseInferred bool `json:"base_inferred"`
	// PrevTruncated 上期结果也被上限截断过，此时「上期没有」可能是「没取到」
	PrevTruncated bool `json:"prev_truncated"`
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
	// Compare 非空时，服务端会按同一口径再查一次上期，并把结果对齐后放进 CompareMeta。
	Compare *Compare `json:"compare,omitempty"`
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
	// Compare 只在请求带 compare 时出现
	Compare *CompareMeta `json:"compare,omitempty"`
}
