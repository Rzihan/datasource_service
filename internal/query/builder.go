package query

import (
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// ErrInvalidQuery 表示查询意图不合法，handler 会映射为 400。
var ErrInvalidQuery = errors.New("invalid query")

// Spec 组装 SQL 所需的全部输入。不含任何 IO，方便表驱动测试。
type Spec struct {
	DatasetKey string
	MidSQL     string
	DimMap     map[string]string
	MtxMap     map[string]string
	Dims       []string
	Metrics    []string
	// Filter 是过滤条件树，支持 AND / OR 任意嵌套；为 nil 表示不加过滤。
	Filter *FilterNode
	// RowFilters 是行级权限条件，由服务端根据数据集配置与登录态合成。
	// 它们恒定以 AND 追加到 WHERE，不进用户的条件树——用户树的根可能是 OR，
	// 塞进去会让权限条件被 OR 吞掉。
	RowFilters   []RowFilter
	OrderBy      []OrderBy
	Limit        int
	MaxLimit     int
	DefaultLimit int
}

// RowFilter 一条已解析好的行级权限条件：列表达式 + 允许的值列表。
// Expr 由服务端从 dim_map 换出来，不接收客户端传入的列文本。
// Values 为空表示「一行都不匹配」（权限配置 fail-closed）。
type RowFilter struct {
	Expr   string
	Values []string
}

// Param 是 SQL 的命名参数，由引擎层转成驱动的参数绑定。
type Param struct {
	Name  string
	Value any
}

const midAlias = "__mid"

// Build 把查询意图组装成 ClickHouse SQL。
//
// 约定：mid_sql 的输出是「可以被再次聚合的中间结果」，外层按用户选的维度重新聚合，
// 这样指标口径统一、不会重复计算。
//
// 安全：dims / metrics / order_by / filter.field 全部走白名单枚举校验，
// 唯一的用户自由输入（过滤值）通过命名参数绑定，不参与字符串拼接。
func Build(spec Spec) (string, []Param, error) {
	midSQL := strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(spec.MidSQL), ";"))
	if midSQL == "" {
		return "", nil, fmt.Errorf("%w: dataset 的 mid_sql 为空", ErrInvalidQuery)
	}
	if len(spec.Dims) == 0 && len(spec.Metrics) == 0 {
		return "", nil, fmt.Errorf("%w: 至少需要选择一个维度或一个指标", ErrInvalidQuery)
	}

	var selectParts []string
	var groupParts []string

	for _, dim := range spec.Dims {
		expr, ok := spec.DimMap[dim]
		if !ok {
			return "", nil, fmt.Errorf("%w: 维度 %q 不在该数据集的 dim_map 中", ErrInvalidQuery, dim)
		}
		selectParts = append(selectParts, fmt.Sprintf("%s AS %s", expr, quote(dim)))
		groupParts = append(groupParts, expr)
	}
	for _, mtx := range spec.Metrics {
		expr, ok := spec.MtxMap[mtx]
		if !ok {
			return "", nil, fmt.Errorf("%w: 指标 %q 不在该数据集的 mtx_map 中", ErrInvalidQuery, mtx)
		}
		selectParts = append(selectParts, fmt.Sprintf("%s AS %s", expr, quote(mtx)))
	}

	// 过滤条件编译成 WHERE / HAVING 两段，见 compileFilter 的说明。
	b := &filterCompiler{spec: spec}
	var whereParts, havingParts []string
	if spec.Filter != nil {
		c, err := b.compile(*spec.Filter, 1)
		if err != nil {
			return "", nil, err
		}
		if c.where != "" {
			whereParts = append(whereParts, c.where)
		}
		if c.having != "" {
			havingParts = append(havingParts, c.having)
		}
	}
	params := b.params

	// 行级权限：恒以 AND 追加到 WHERE（聚合前）。
	// 列表为空时 IN () 不匹配任何行——权限配置 fail-closed，宁可看不到也不能看到别人的。
	for i, rf := range spec.RowFilters {
		if rf.Expr == "" {
			continue
		}
		name := fmt.Sprintf("rf%d", i)
		values := rf.Values
		if values == nil {
			values = []string{}
		}
		whereParts = append(whereParts, fmt.Sprintf("%s IN ({%s:Array(String)})", rf.Expr, name))
		params = append(params, Param{Name: name, Value: values})
	}

	// 排序字段必须是已选中的维度或指标，否则无法在 SELECT 里找到对应列。
	var orderParts []string
	for _, o := range spec.OrderBy {
		isDim := contains(spec.Dims, o.Field)
		isMtx := contains(spec.Metrics, o.Field)
		if !isDim && !isMtx {
			return "", nil, fmt.Errorf("%w: 排序字段 %q 必须是已选择的维度或指标", ErrInvalidQuery, o.Field)
		}
		dir := "ASC"
		if o.Desc {
			dir = "DESC"
		}
		orderParts = append(orderParts, fmt.Sprintf("%s %s", quote(o.Field), dir))
	}

	limit := spec.Limit
	if limit <= 0 {
		limit = spec.DefaultLimit
	}
	if spec.MaxLimit > 0 && limit > spec.MaxLimit {
		limit = spec.MaxLimit
	}
	if limit <= 0 {
		limit = 1000
	}

	var sb strings.Builder
	sb.WriteString("SELECT\n  ")
	sb.WriteString(strings.Join(selectParts, ",\n  "))
	sb.WriteString("\nFROM (\n")
	sb.WriteString(midSQL)
	sb.WriteString("\n) AS ")
	sb.WriteString(midAlias)
	if len(whereParts) > 0 {
		sb.WriteString("\nWHERE ")
		sb.WriteString(strings.Join(whereParts, " AND "))
	}
	if len(groupParts) > 0 {
		sb.WriteString("\nGROUP BY ")
		sb.WriteString(strings.Join(groupParts, ", "))
	}
	if len(havingParts) > 0 {
		sb.WriteString("\nHAVING ")
		sb.WriteString(strings.Join(havingParts, " AND "))
	}
	if len(orderParts) > 0 {
		sb.WriteString("\nORDER BY ")
		sb.WriteString(strings.Join(orderParts, ", "))
	}
	sb.WriteString(fmt.Sprintf("\nLIMIT %d", limit))
	return sb.String(), params, nil
}

// cond 是一个条件（或一组条件）编译后的两种形态：
//
//   - where：可以在聚合前判断，能大幅减少参与聚合的行数，优先使用
//   - having：只能在聚合后判断（指标条件必然如此）
//
// 两者都可能为空，也可能同时有值（见 AND 节点的拆分）。
type cond struct {
	where  string
	having string
}

// filterCompiler 递归编译条件树，顺带收集参数。
type filterCompiler struct {
	spec      Spec
	params    []Param
	paramSeq  int
	nodeCount int
}

// compile 把条件树编译成 WHERE / HAVING 两段。
//
// 为什么要拆两段：维度条件是行级的，聚合前就能筛掉大量数据；
// 指标只有聚合后才有值。所以能下压的尽量下压，压不下去的才进 HAVING。
//
// 遇到 AND / OR 混用时，有些组合是算不出来的，例如
// 「渠道 = 抖音 OR 消耗 > 1000」：渠道没被勾选为维度，聚合后根本没有这一列，
// 只能在聚合前筛；而消耗只有聚合后才有值。二者无法用 OR 连接。
// 这种情况返回明确的中文错误，而不是生成一条语义不明的 SQL。
func (b *filterCompiler) compile(node FilterNode, depth int) (cond, error) {
	if depth > MaxFilterDepth {
		return cond{}, fmt.Errorf("%w: 过滤条件嵌套超过 %d 层", ErrInvalidQuery, MaxFilterDepth)
	}
	b.nodeCount++
	if b.nodeCount > MaxFilterNodes {
		return cond{}, fmt.Errorf("%w: 过滤条件超过 %d 个", ErrInvalidQuery, MaxFilterNodes)
	}

	if !node.IsGroup() {
		return b.compileLeaf(node)
	}

	logic := strings.ToLower(strings.TrimSpace(node.Logic))
	if logic != LogicAnd && logic != LogicOr {
		return cond{}, fmt.Errorf("%w: 不支持的逻辑运算符 %q，只能用 and / or", ErrInvalidQuery, node.Logic)
	}
	if len(node.Children) == 0 {
		return cond{}, fmt.Errorf("%w: %s 分组下至少需要一个条件", ErrInvalidQuery, logic)
	}

	subs := make([]cond, 0, len(node.Children))
	for _, c := range node.Children {
		sc, err := b.compile(c, depth+1)
		if err != nil {
			return cond{}, err
		}
		subs = append(subs, sc)
	}

	// OR 整组必须待在同一段里：一旦一部分下压到 WHERE、另一部分留在 HAVING，
	// 两段之间就变成了 AND，语义完全变了。
	if logic == LogicOr {
		if ws, ok := collectAll(subs, func(c cond) string { return c.where }); ok {
			return cond{where: joinCond(ws, LogicOr)}, nil
		}
		if hs, ok := collectAll(subs, func(c cond) string { return c.having }); ok {
			return cond{having: joinCond(hs, LogicOr)}, nil
		}
		return cond{}, fmt.Errorf("%w: 这组 OR 条件算不出来：其中既有只能在聚合前判断的条件（未勾选的维度），又有只能在聚合后判断的条件（指标），二者不能用 OR 连接", ErrInvalidQuery)
	}

	// AND 可以拆：能下压的进 WHERE，压不下去的进 HAVING，两段用 AND 连接后等价。
	var ws, hs []string
	for _, c := range subs {
		switch {
		case c.where != "":
			ws = append(ws, c.where)
		case c.having != "":
			hs = append(hs, c.having)
		default:
			return cond{}, fmt.Errorf("%w: 这组 AND 条件算不出来：其中一个条件既不能下压到聚合前、也无法在聚合后判断", ErrInvalidQuery)
		}
	}
	out := cond{}
	if len(ws) > 0 {
		out.where = joinCond(ws, LogicAnd)
	}
	if len(hs) > 0 {
		out.having = joinCond(hs, LogicAnd)
	}
	return out, nil
}

// compileLeaf 编译单个条件。
func (b *filterCompiler) compileLeaf(node FilterNode) (cond, error) {
	if strings.TrimSpace(node.Field) == "" {
		return cond{}, fmt.Errorf("%w: 过滤条件缺少 field", ErrInvalidQuery)
	}
	op := strings.ToLower(strings.TrimSpace(node.Op))
	if !allowedOps[op] {
		return cond{}, fmt.Errorf("%w: 不支持的操作符 %q", ErrInvalidQuery, node.Op)
	}

	// 维度是行级条件，永远可以下压到 WHERE；若它同时被选为分组键，
	// 聚合后这一列还在，所以再给一份 HAVING 形态备用。
	if dimExpr, ok := b.spec.DimMap[node.Field]; ok {
		ph, err := b.bind(op, false, node)
		if err != nil {
			return cond{}, err
		}
		c := cond{where: fmt.Sprintf("%s %s %s", dimExpr, op, ph)}
		if contains(b.spec.Dims, node.Field) {
			c.having = fmt.Sprintf("%s %s %s", quote(node.Field), op, ph)
		}
		return c, nil
	}

	// 指标只有聚合后才有值，只能进 HAVING。
	if _, ok := b.spec.MtxMap[node.Field]; ok {
		if !contains(b.spec.Metrics, node.Field) {
			return cond{}, fmt.Errorf("%w: 过滤指标 %q 未被勾选，只有已选择的指标才能用于过滤", ErrInvalidQuery, node.Field)
		}
		if !metricOps[op] {
			return cond{}, fmt.Errorf("%w: 指标过滤不支持操作符 %q，请使用 = != > >= < <= in not in", ErrInvalidQuery, op)
		}
		ph, err := b.bind(op, true, node)
		if err != nil {
			return cond{}, err
		}
		// 引用别名而不是重复写聚合表达式：ClickHouse 会把 SELECT 的别名带进 HAVING，
		// 指标 key 与表达式列名同名时 sum(clicks) 会被解析成 sum(sum(clicks))。
		return cond{having: fmt.Sprintf("%s %s %s", quote(node.Field), op, ph)}, nil
	}

	return cond{}, fmt.Errorf("%w: 过滤字段 %q 不在该数据集的 dim_map / mtx_map 中", ErrInvalidQuery, node.Field)
}

// bind 生成命名参数占位符并登记参数值。
func (b *filterCompiler) bind(op string, isMetric bool, node FilterNode) (string, error) {
	name := fmt.Sprintf("p%d", b.paramSeq)
	b.paramSeq++

	if op == OpIn || op == OpNotIn {
		if len(node.Values) == 0 {
			return "", fmt.Errorf("%w: 过滤字段 %q 的 %s 操作需要提供 values", ErrInvalidQuery, node.Field, op)
		}
		typ, val := arrayParam(isMetric, node.Values)
		b.params = append(b.params, Param{Name: name, Value: val})
		// in / not in 的值列表需要元组括号：expr in ({p0:Array(String)})
		return fmt.Sprintf("({%s:%s})", name, typ), nil
	}
	if strings.TrimSpace(node.Value) == "" {
		return "", fmt.Errorf("%w: 过滤字段 %q 的值为空", ErrInvalidQuery, node.Field)
	}
	typ, val := scalarParam(isMetric, node.Value)
	b.params = append(b.params, Param{Name: name, Value: val})
	return fmt.Sprintf("{%s:%s}", name, typ), nil
}

// joinCond 用逻辑运算符连接多个条件，单个条件时不加多余的括号。
func joinCond(parts []string, logic string) string {
	if len(parts) == 1 {
		return parts[0]
	}
	sep := " AND "
	if logic == LogicOr {
		sep = " OR "
	}
	return "(" + strings.Join(parts, sep) + ")"
}

// collectAll 取出每个子结果的指定形态，只要有任何一个缺失就返回 false。
func collectAll(subs []cond, pick func(cond) string) ([]string, bool) {
	out := make([]string, 0, len(subs))
	for _, c := range subs {
		v := pick(c)
		if v == "" {
			return nil, false
		}
		out = append(out, v)
	}
	return out, true
}

// FilterNodeFields 收集条件树里引用到的所有字段名，用于列级权限校验。
func FilterNodeFields(n *FilterNode) []string {
	if n == nil {
		return nil
	}
	if !n.IsGroup() {
		if n.Field == "" {
			return nil
		}
		return []string{n.Field}
	}
	out := make([]string, 0, len(n.Children))
	for i := range n.Children {
		out = append(out, FilterNodeFields(&n.Children[i])...)
	}
	return out
}

// FilterNodeCount 统计条件树的节点总数（日志用）。
func FilterNodeCount(n *FilterNode) int {
	if n == nil {
		return 0
	}
	total := 1
	for i := range n.Children {
		total += FilterNodeCount(&n.Children[i])
	}
	return total
}

// BuildDimValuesSQL 生成「某维度的候选值」查询，供前端下拉枚举使用。
//
// 行级权限必须在这里一起注入：否则下拉框会把别人租户/用户下的取值也枚举出来，
// 等于绕过了一半的行级管控。
func BuildDimValuesSQL(midSQL string, dimExpr string, limit int, rowFilters []RowFilter) (string, []Param) {
	mid := strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(midSQL), ";"))

	var params []Param
	var sb strings.Builder
	fmt.Fprintf(&sb,
		"SELECT DISTINCT %s AS value FROM (\n%s\n) AS %s WHERE %s IS NOT NULL",
		dimExpr, mid, midAlias, dimExpr,
	)
	for i, rf := range rowFilters {
		if rf.Expr == "" {
			continue
		}
		name := fmt.Sprintf("rf%d", i)
		values := rf.Values
		if values == nil {
			values = []string{}
		}
		fmt.Fprintf(&sb, " AND %s IN ({%s:Array(String)})", rf.Expr, name)
		params = append(params, Param{Name: name, Value: values})
	}
	fmt.Fprintf(&sb, " ORDER BY value LIMIT %d", limit)
	return sb.String(), params
}

// quote 用反引号包裹标识符。内部已做反引号转义，避免列名本身含反引号时破坏语法。
func quote(name string) string {
	return "`" + strings.ReplaceAll(name, "`", "``") + "`"
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// SortedKeys 返回 map 的排序后的 key 列表，保证前端看到的维度/指标顺序稳定。
func SortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// scalarParam 推断单个过滤值的参数类型。
//
// 关键：指标是聚合结果（Decimal / UInt64 居多），而 ClickHouse 类型严格，
// "Decimal 与 String 比较" 会直接报错。所以指标过滤的值若能解析成数字，
// 就以 Float64 绑定；维度过滤一律按 String 处理。
func scalarParam(isMetric bool, value string) (string, any) {
	if isMetric {
		if f, err := strconv.ParseFloat(strings.TrimSpace(value), 64); err == nil {
			return "Float64", f
		}
	}
	return "String", value
}

// arrayParam 推断 in / not in 的值列表类型，全部能解析成数字才用 Float64 数组。
func arrayParam(isMetric bool, values []string) (string, any) {
	if isMetric {
		out := make([]float64, 0, len(values))
		for _, v := range values {
			f, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
			if err != nil {
				return "Array(String)", values
			}
			out = append(out, f)
		}
		return "Array(Float64)", out
	}
	return "Array(String)", values
}
