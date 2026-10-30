package query

import (
	"testing"
	"time"
)

func d(s string) time.Time {
	t, err := time.Parse(dateLayout, s)
	if err != nil {
		panic(err)
	}
	return t
}

// 等长前移：近 7 天 → 上一个 7 天，首尾都要含进去。
// 差一天是最常见的错——「近 7 天」写成 to-from 天就变成 6 天，环比直接失真。
func TestShiftPeriodPrevPeriod(t *testing.T) {
	from, to, err := ShiftPeriod(d("2026-10-24"), d("2026-10-30"), ComparePrevPeriod)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got := from.Format(dateLayout); got != "2026-10-17" {
		t.Fatalf("prev from = %s, want 2026-10-17", got)
	}
	if got := to.Format(dateLayout); got != "2026-10-23" {
		t.Fatalf("prev to = %s, want 2026-10-23", got)
	}
}

func TestShiftPeriodPrevYear(t *testing.T) {
	from, to, err := ShiftPeriod(d("2026-10-01"), d("2026-10-30"), ComparePrevYear)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if from.Format(dateLayout) != "2025-10-01" || to.Format(dateLayout) != "2025-10-30" {
		t.Fatalf("got %s ~ %s", from.Format(dateLayout), to.Format(dateLayout))
	}
}

func TestShiftPeriodRejectsUnknownMode(t *testing.T) {
	if _, _, err := ShiftPeriod(d("2026-10-01"), d("2026-10-07"), "mom"); err == nil {
		t.Fatal("未支持的对比方式应当报错，否则会静默拿本期跟自己比")
	}
}

func TestFindDateRange(t *testing.T) {
	tree := FilterNode{Logic: LogicAnd, Children: []FilterNode{
		{Field: "stat_date", Op: OpGte, Value: "2026-10-01"},
		{Field: "stat_date", Op: OpLte, Value: "2026-10-30"},
		{Field: "city", Op: OpEq, Value: "北京"},
	}}
	from, to, ok := FindDateRange(&tree, "stat_date")
	if !ok || from != "2026-10-01" || to != "2026-10-30" {
		t.Fatalf("got %s ~ %s ok=%v", from, to, ok)
	}

	if _, _, ok := FindDateRange(&tree, "other_date"); ok {
		t.Fatal("不该在别的字段上找到区间")
	}
}

// 根是 OR 时，区间必须被 AND 上去而不是塞进 OR——
// 塞进 OR 的后果是条件被吞掉、查出来是全量，而界面看着是筛过的。
func TestReplaceRangeOnOrRoot(t *testing.T) {
	tree := FilterNode{Logic: LogicOr, Children: []FilterNode{
		{Field: "city", Op: OpEq, Value: "北京"},
		{Field: "city", Op: OpEq, Value: "上海"},
		{Field: "stat_date", Op: OpGte, Value: "2026-10-01"},
	}}
	out := ReplaceRange(tree, "stat_date", "2026-09-01", "2026-09-30")

	if out.Logic != LogicAnd {
		t.Fatalf("root logic = %q, want and（否则区间会被 OR 吞掉）", out.Logic)
	}
	var orNode *FilterNode
	for i := range out.Children {
		if out.Children[i].Logic == LogicOr {
			orNode = &out.Children[i]
		}
	}
	if orNode == nil || len(orNode.Children) != 2 {
		t.Fatalf("原 OR 条件应被收进子分组且保留两个城市，got %+v", out)
	}
	from, to, ok := FindDateRange(&out, "stat_date")
	if !ok || from != "2026-09-01" || to != "2026-09-30" {
		t.Fatalf("区间未替换成功: %s ~ %s", from, to)
	}
}

// 原来的区间条件必须被替换掉而不是叠加：留下旧边界会让上期查询永远返回空。
func TestReplaceRangeDropsOldBounds(t *testing.T) {
	tree := FilterNode{Logic: LogicAnd, Children: []FilterNode{
		{Field: "stat_date", Op: OpGte, Value: "2026-10-01"},
		{Field: "stat_date", Op: OpLte, Value: "2026-10-30"},
		{Field: "scene", Op: OpEq, Value: "倒水"},
	}}
	out := ReplaceRange(tree, "stat_date", "2026-09-01", "2026-09-30")
	if len(out.Children) != 3 {
		t.Fatalf("want 3 children（scene + 新边界两条），got %d: %+v", len(out.Children), out.Children)
	}
	from, to, _ := FindDateRange(&out, "stat_date")
	if from != "2026-09-01" || to != "2026-09-30" {
		t.Fatalf("旧边界没被替换: %s ~ %s", from, to)
	}
}

func TestMergeCompareAlignsByDimsNotRowOrder(t *testing.T) {
	base := &ExecuteResult{
		Columns: []Column{{Name: "scene"}, {Name: "units"}},
		Rows:    [][]any{{"倒水", "100"}, {"叠衣", "50"}},
	}
	// 上期行序相反，按行号对齐会把 100 对上 60
	prev := &ExecuteResult{
		Columns: []Column{{Name: "scene"}, {Name: "units"}},
		Rows:    [][]any{{"叠衣", "60"}, {"倒水", "80"}, {"擦桌", "10"}},
	}
	out, meta := MergeCompare(base, prev, []string{"scene"}, []string{"units"})

	if out.RowCount != 3 {
		t.Fatalf("上期独有的「擦桌」应被补一行，got row_count=%d", out.RowCount)
	}
	// 用第二列读出来看对齐结果
	got := map[string]any{}
	for _, r := range out.Rows {
		got[r[0].(string)] = r[1]
	}
	if got["倒水"] != "100" || got["叠衣"] != "50" {
		t.Fatalf("本期值不该被改写: %+v", got)
	}
	if got["擦桌"] != nil {
		t.Fatalf("补进来的行本期指标应为 NULL 而不是 0，got %v", got["擦桌"])
	}
	pv := meta.PrevValues["units"]
	if pv[0] != "80" || pv[1] != "60" || pv[2] != "10" {
		t.Fatalf("上期值对齐错误: %+v", pv)
	}
	if meta.AddedRows != 1 {
		t.Fatalf("AddedRows = %d, want 1", meta.AddedRows)
	}
}

func TestMergeCompareHandlesNullDims(t *testing.T) {
	base := &ExecuteResult{
		Columns: []Column{{Name: "channel"}, {Name: "cost"}},
		Rows:    [][]any{{nil, "10"}},
	}
	// 空串与 NULL 是两个分组，不能被合并成一行
	prev := &ExecuteResult{
		Columns: []Column{{Name: "channel"}, {Name: "cost"}},
		Rows:    [][]any{{"", "20"}},
	}
	out, meta := MergeCompare(base, prev, []string{"channel"}, []string{"cost"})
	if out.RowCount != 2 {
		t.Fatalf("NULL 与空串必须保持两个分组，got %d 行", out.RowCount)
	}
	if meta.PrevValues["cost"][0] != nil {
		t.Fatalf("NULL 渠道本期不该匹配到空串上期，got %v", meta.PrevValues["cost"][0])
	}
}

// 按天看周同比：上期日期要整体平移到本期时间轴上，才能与本期同一天配对。
func TestShiftDimDates(t *testing.T) {
	prev := &ExecuteResult{
		Columns: []Column{{Name: "date"}, {Name: "episodes"}},
		Rows:    [][]any{{"2026-10-17", "100"}, {"2026-10-18", "120"}},
	}
	ShiftDimDates(prev, 0, 7)
	if prev.Rows[0][0] != "2026-10-24" || prev.Rows[1][0] != "2026-10-25" {
		t.Fatalf("日期没平移: %v", prev.Rows)
	}

	base := &ExecuteResult{
		Columns: []Column{{Name: "date"}, {Name: "episodes"}},
		Rows:    [][]any{{"2026-10-24", "150"}, {"2026-10-25", "140"}},
	}
	out, meta := MergeCompare(base, prev, []string{"date"}, []string{"episodes"})
	if out.RowCount != 2 || meta.AddedRows != 0 {
		t.Fatalf("平移后两期应当一一对上，got rows=%d added=%d", out.RowCount, meta.AddedRows)
	}
	if meta.PrevValues["episodes"][0] != "100" {
		t.Fatalf("上期值对错了: %v", meta.PrevValues["episodes"])
	}
}
