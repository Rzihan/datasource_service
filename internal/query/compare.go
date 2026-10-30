package query

import (
	"fmt"
	"strings"
	"time"
)

// 对比周期（同环比）。
//
// 实现思路刻意保守：**不新增 SQL 能力，只是拿同一份查询再跑一次**。
// 上期查询 = 本期查询的条件树，把日期维度上的区间换成平移后的区间。
// 好处是口径天然一致——指标表达式、行级权限、多值维度收拢全都自动复用，
// 不会出现「本期 sum、上期 avg」这种两张 SQL 各写一遍导致的偏差。

const dateLayout = "2006-01-02"

// rangeOps 是可以构成「区间」的操作符。
var rangeOps = map[string]bool{OpGte: true, OpLte: true, OpGt: true, OpLt: true, OpEq: true}

// FindDateRange 在条件树里找出针对 field 的日期边界。
//
// 只收集不判断结构：根节点是 OR 时，「区间」并不是全局约束，
// 但前端把时间范围固定写在 AND 根上，这里按最宽的含义取 min/max 就够用，
// 硬去判断布尔结构反而容易把简单问题做复杂。
func FindDateRange(n *FilterNode, field string) (from, to string, ok bool) {
	if n == nil {
		return "", "", false
	}
	walkFilter(*n, func(leaf FilterNode) {
		if leaf.Field != field || !rangeOps[leaf.Op] {
			return
		}
		v := strings.TrimSpace(leaf.Value)
		if v == "" {
			return
		}
		for _, one := range strings.Split(v, ",") {
			one = strings.TrimSpace(one)
			if one == "" {
				continue
			}
			if from == "" || one < from {
				from = one
			}
			if to == "" || one > to {
				to = one
			}
			ok = true
		}
	})
	return from, to, ok
}

func walkFilter(n FilterNode, fn func(FilterNode)) {
	if n.IsGroup() {
		for _, c := range n.Children {
			walkFilter(c, fn)
		}
		return
	}
	fn(n)
}

// ShiftPeriod 由本期区间算出对比区间。
func ShiftPeriod(from, to time.Time, mode string) (time.Time, time.Time, error) {
	switch mode {
	case ComparePrevPeriod:
		// 等长前移：区间含首尾，所以天数 = 差值 + 1。
		// 近 7 天（10-24~10-30）→ 上一个 7 天（10-17~10-23）。
		days := int(to.Sub(from).Hours()/24) + 1
		if days <= 0 {
			return time.Time{}, time.Time{}, fmt.Errorf("%w: 时间区间不合法", ErrInvalidQuery)
		}
		prevTo := from.AddDate(0, 0, -1)
		return prevTo.AddDate(0, 0, -(days - 1)), prevTo, nil
	case ComparePrevYear:
		return from.AddDate(-1, 0, 0), to.AddDate(-1, 0, 0), nil
	default:
		return time.Time{}, time.Time{}, fmt.Errorf("%w: 不支持的对比方式 %q", ErrInvalidQuery, mode)
	}
}

// ReplaceRange 把条件树里 field 上的区间条件整体换成 [from, to]，其余条件原样保留。
//
// 根节点是 OR 时必须把剩余条件包成子分组再 AND 上新区间：
// 直接把两个边界条件塞进 OR，会变成「满足任一条件即可」，
// 查出来的数看着正常、其实是全量，是这类改动最典型的坑。
func ReplaceRange(n FilterNode, field, from, to string) FilterNode {
	rest := stripRangeNode(n, field)

	lo := FilterNode{Field: field, Op: OpGte, Value: from}
	hi := FilterNode{Field: field, Op: OpLte, Value: to}

	switch {
	case rest.IsGroup() && rest.Logic == LogicAnd:
		rest.Children = append(rest.Children, lo, hi)
		return rest
	case rest.IsGroup() && rest.Logic == LogicOr:
		if len(rest.Children) == 0 {
			return FilterNode{Logic: LogicAnd, Children: []FilterNode{lo, hi}}
		}
		return FilterNode{Logic: LogicAnd, Children: []FilterNode{rest, lo, hi}}
	case rest.IsGroup():
		return FilterNode{Logic: LogicAnd, Children: append(rest.Children, lo, hi)}
	case rest.Field == "" && rest.Op == "":
		return FilterNode{Logic: LogicAnd, Children: []FilterNode{lo, hi}}
	default:
		// 根上就一个叶子条件：包成 AND 分组，否则两个区间条件无处安放
		return FilterNode{Logic: LogicAnd, Children: []FilterNode{rest, lo, hi}}
	}
}

// stripRangeNode 去掉 field 上的区间条件，空分组会被剪掉——
// 否则会留下一个「AND 里什么都没有」的空壳，编译 WHERE 时容易出怪 SQL。
func stripRangeNode(n FilterNode, field string) FilterNode {
	if n.IsGroup() {
		out := FilterNode{Logic: n.Logic}
		for _, c := range n.Children {
			cleaned := stripRangeNode(c, field)
			if cleaned.IsGroup() && len(cleaned.Children) == 0 {
				continue
			}
			if !cleaned.IsGroup() && cleaned.Field == "" {
				continue
			}
			out.Children = append(out.Children, cleaned)
		}
		return out
	}
	if n.Field == field && rangeOps[n.Op] {
		return FilterNode{}
	}
	return n
}

// BuildDateRangeSQL 探测某个日期维度在「其它条件不变」下的最小 / 最大取值。
//
// 用户常常不设时间范围（默认查全量），这时要有话可比较，就得先知道数据覆盖哪一段。
// 只扫两列、走的是同一个 mid_sql，代价和一次候选值枚举相当。
func BuildDateRangeSQL(midSQL, expr string, rowFilters []RowFilter) (string, []Param) {
	var sb strings.Builder
	var params []Param
	sb.WriteString("SELECT toString(min(")
	sb.WriteString(expr)
	sb.WriteString(")) AS lo, toString(max(")
	sb.WriteString(expr)
	sb.WriteString(")) AS hi\nFROM (\n")
	sb.WriteString(midSQL)
	sb.WriteString("\n) AS ")
	sb.WriteString(midAlias)

	var where []string
	for i, rf := range rowFilters {
		if rf.Expr == "" {
			continue
		}
		name := fmt.Sprintf("rf%d", i)
		values := rf.Values
		if values == nil {
			values = []string{}
		}
		where = append(where, fmt.Sprintf("%s IN ({%s:Array(String)})", rf.Expr, name))
		params = append(params, Param{Name: name, Value: values})
	}
	if len(where) > 0 {
		sb.WriteString("\nWHERE ")
		sb.WriteString(strings.Join(where, " AND "))
	}
	return sb.String(), params
}

// MergeCompare 把上期结果按维度对齐到本期结果上。
//
// 三件事必须都做到，否则环比会悄悄骗人：
//  1. 只在本期有的组合 → 上期值 nil（不是 0，0 会让「从无到有」看起来像持平）；
//  2. 只在上期有的组合 → 补成一行，本期指标 nil（否则「掉了 100%」的那个客户直接消失）；
//  3. 对齐用维度元组做 key，不靠行序——两个周期的默认排序不同，按下标对齐必然错位。
func MergeCompare(base, prev *ExecuteResult, dims, metrics []string) (*ExecuteResult, *CompareMeta) {
	dimCnt := len(dims)

	keyOf := func(row []any) string {
		var sb strings.Builder
		for i := 0; i < dimCnt && i < len(row); i++ {
			sb.WriteString(cellKey(row[i]))
			sb.WriteByte(0x1f)
		}
		return sb.String()
	}

	prevByKey := make(map[string][]any, len(prev.Rows))
	for _, r := range prev.Rows {
		prevByKey[keyOf(r)] = r
	}

	colIdx := make(map[string]int, len(base.Columns))
	for i, c := range base.Columns {
		colIdx[c.Name] = i
	}

	prevVals := make(map[string][]any, len(metrics))
	for _, m := range metrics {
		prevVals[m] = make([]any, 0, len(base.Rows))
	}

	rows := make([][]any, 0, len(base.Rows)+len(prev.Rows))
	for _, r := range base.Rows {
		rows = append(rows, r)
		pv := prevByKey[keyOf(r)]
		for _, m := range metrics {
			idx, ok := colIdx[m]
			if !ok || pv == nil || idx >= len(pv) {
				prevVals[m] = append(prevVals[m], nil)
				continue
			}
			prevVals[m] = append(prevVals[m], pv[idx])
		}
	}

	// 上期有、本期没有的维度组合，补到末尾（本期指标留空）
	baseKeys := make(map[string]struct{}, len(base.Rows))
	for _, r := range base.Rows {
		baseKeys[keyOf(r)] = struct{}{}
	}
	added := 0
	for key, pv := range prevByKey {
		if _, ok := baseKeys[key]; ok {
			continue
		}
		row := make([]any, len(base.Columns))
		for i := 0; i < dimCnt && i < len(pv); i++ {
			row[i] = pv[i]
		}
		// 指标列本来就该是 nil，显式留空而不是填 0
		for _, m := range metrics {
			if idx, ok := colIdx[m]; ok && idx < len(pv) {
				prevVals[m] = append(prevVals[m], pv[idx])
			} else {
				prevVals[m] = append(prevVals[m], nil)
			}
		}
		rows = append(rows, row)
		added++
	}

	out := *base
	out.Rows = rows
	out.RowCount = len(rows)
	// 补进来的行不属于「本期」，截断语义只对本期成立，所以不再标截断
	if added > 0 {
		out.Truncated = false
	}
	return &out, &CompareMeta{PrevValues: prevVals, AddedRows: added}
}

// cellKey 把单元格变成可比较的字符串。NULL 与空串必须区分开，
// 否则「渠道为空」的分组会和「渠道=”」的分组合并成一行。
func cellKey(v any) string {
	if v == nil {
		return "<nil>"
	}
	return fmt.Sprintf("%v", v)
}

// ShiftDimDates 把上期结果里某一列（日期维度）整体平移到本期的时间轴上。
//
// 为什么需要：当对比字段本身就是分组维度（按天看「本周 vs 上周」）时，
// 两期的日期值天然不重叠，按值对齐永远配不上——结果会变成 14 行，
// 其中 7 行本期为空、7 行上期为空，没有任何一张能读的表。
// 正确做法是按「期内的第几天」对齐：把上期的 10-17 平移成 10-24，再合并。
//
// offsetDays 由两期的起始日相减得到，不是固定 7/30——
// 用户自己圈一个 14 天区间时，它就是 14。
func ShiftDimDates(res *ExecuteResult, colIdx, offsetDays int) {
	if res == nil || colIdx < 0 || offsetDays == 0 {
		return
	}
	for _, row := range res.Rows {
		if colIdx >= len(row) {
			continue
		}
		v, ok := row[colIdx].(string)
		if !ok || len(v) < 10 {
			continue
		}
		t, err := time.Parse(dateLayout, v[:10])
		if err != nil {
			continue
		}
		row[colIdx] = t.AddDate(0, 0, offsetDays).Format(dateLayout) + v[10:]
	}
}
