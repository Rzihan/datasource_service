package query

import (
	"errors"
	"strings"
	"testing"
)

func baseSpec() Spec {
	return Spec{
		DatasetKey:   "order_daily",
		MidSQL:       "select stat_date, city_code, stat_cost, clicks from t_order_dtl",
		DimMap:       map[string]string{"date": "stat_date", "city": "city_code"},
		MtxMap:       map[string]string{"cost": "sum(stat_cost)", "click": "sum(clicks)"},
		Dims:         []string{"date"},
		Metrics:      []string{"cost"},
		MaxLimit:     10000,
		DefaultLimit: 1000,
	}
}

func TestBuildBasic(t *testing.T) {
	spec := baseSpec()
	spec.Filter = &FilterNode{Logic: "and", Children: []FilterNode{{Field: "city", Op: "=", Value: "北京"}}}
	spec.OrderBy = []OrderBy{{Field: "cost", Desc: true}}
	spec.Limit = 100

	sql, params, err := Build(spec)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	for _, want := range []string{
		"stat_date AS `date`",
		"sum(stat_cost) AS `cost`",
		"FROM (\nselect stat_date, city_code, stat_cost, clicks from t_order_dtl\n) AS __mid",
		"WHERE city_code = {p0:String}",
		"GROUP BY stat_date",
		"ORDER BY `cost` DESC",
		"LIMIT 100",
	} {
		if !strings.Contains(sql, want) {
			t.Errorf("sql missing %q\n--- sql ---\n%s", want, sql)
		}
	}
	if len(params) != 1 || params[0].Name != "p0" || params[0].Value != "北京" {
		t.Fatalf("unexpected params: %+v", params)
	}
}

// 过滤值必须走参数绑定，绝不能出现在 SQL 字符串里——这是唯一的注入面。
func TestBuildDoesNotInlineFilterValue(t *testing.T) {
	spec := baseSpec()
	spec.Filter = &FilterNode{Logic: "and", Children: []FilterNode{{Field: "city", Op: "=", Value: "' OR 1=1 --"}}}
	sql, params, err := Build(spec)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if strings.Contains(sql, "OR 1=1") {
		t.Fatalf("filter value leaked into sql:\n%s", sql)
	}
	if len(params) != 1 || params[0].Value != "' OR 1=1 --" {
		t.Fatalf("value should be passed as a bound param, got %+v", params)
	}
}

func TestBuildInOperator(t *testing.T) {
	spec := baseSpec()
	spec.Filter = &FilterNode{Logic: "and", Children: []FilterNode{{Field: "city", Op: "in", Values: []string{"北京", "上海"}}}}
	sql, params, err := Build(spec)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(sql, "city_code in ({p0:Array(String)})") {
		t.Fatalf("unexpected sql:\n%s", sql)
	}
	if len(params) != 1 {
		t.Fatalf("unexpected params: %+v", params)
	}
}

func TestBuildLimitClamped(t *testing.T) {
	spec := baseSpec()
	spec.Limit = 999999
	sql, _, err := Build(spec)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.HasSuffix(sql, "LIMIT 10000") {
		t.Fatalf("limit not clamped:\n%s", sql)
	}
}

func TestBuildDefaultLimit(t *testing.T) {
	spec := baseSpec()
	spec.Limit = 0
	sql, _, err := Build(spec)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.HasSuffix(sql, "LIMIT 1000") {
		t.Fatalf("default limit not applied:\n%s", sql)
	}
}

func TestBuildNoDims(t *testing.T) {
	spec := baseSpec()
	spec.Dims = nil
	sql, _, err := Build(spec)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if strings.Contains(sql, "GROUP BY") {
		t.Fatalf("no dims should not group:\n%s", sql)
	}
}

func TestBuildRejects(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(s *Spec)
	}{
		{"维度不在 dim_map", func(s *Spec) { s.Dims = []string{"nope"} }},
		{"指标不在 mtx_map", func(s *Spec) { s.Metrics = []string{"nope"} }},
		{"维度指标都为空", func(s *Spec) { s.Dims = nil; s.Metrics = nil }},
		{"排序字段未选中", func(s *Spec) { s.OrderBy = []OrderBy{{Field: "city"}} }},
		{"过滤字段不在 dim_map", func(s *Spec) {
			s.Filter = &FilterNode{Logic: "and", Children: []FilterNode{{Field: "nope", Op: "=", Value: "x"}}}
		}},
		{"非法操作符", func(s *Spec) {
			s.Filter = &FilterNode{Logic: "and", Children: []FilterNode{{Field: "city", Op: "drop", Value: "x"}}}
		}},
		{"过滤值为空", func(s *Spec) {
			s.Filter = &FilterNode{Logic: "and", Children: []FilterNode{{Field: "city", Op: "=", Value: "  "}}}
		}},
		{"in 操作缺 values", func(s *Spec) {
			s.Filter = &FilterNode{Logic: "and", Children: []FilterNode{{Field: "city", Op: "in"}}}
		}},
		{"mid_sql 为空", func(s *Spec) { s.MidSQL = "  " }},
	}
	for _, c := range cases {
		spec := baseSpec()
		c.mutate(&spec)
		if _, _, err := Build(spec); err == nil {
			t.Errorf("%s: expected error, got nil", c.name)
		} else if !errors.Is(err, ErrInvalidQuery) {
			t.Errorf("%s: error should wrap ErrInvalidQuery, got %v", c.name, err)
		}
	}
}

// 指标过滤必须落到 HAVING，且数值要绑成 Float64——
// ClickHouse 不允许 Decimal 与 String 直接比较。
func TestBuildMetricFilterGoesToHaving(t *testing.T) {
	spec := baseSpec()
	spec.Filter = &FilterNode{Logic: "and", Children: []FilterNode{{Field: "cost", Op: ">", Value: "1000"}}}
	sql, params, err := Build(spec)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(sql, "HAVING `cost` > {p0:Float64}") {
		t.Fatalf("expected HAVING with Float64 param, got:\n%s", sql)
	}
	if strings.Contains(sql, "WHERE") {
		t.Fatalf("metric filter should not go to WHERE:\n%s", sql)
	}
	if len(params) != 1 {
		t.Fatalf("unexpected params: %+v", params)
	}
	if v, ok := params[0].Value.(float64); !ok || v != 1000 {
		t.Fatalf("value should be float64(1000), got %#v", params[0].Value)
	}
}

// 维度过滤仍然走 WHERE，参数保持 String。
func TestBuildDimFilterStillUsesWhere(t *testing.T) {
	spec := baseSpec()
	spec.Filter = &FilterNode{Logic: "and", Children: []FilterNode{{Field: "city", Op: "=", Value: "1000"}}}
	sql, params, err := Build(spec)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(sql, "WHERE city_code = {p0:String}") {
		t.Fatalf("dim filter should stay in WHERE with String param:\n%s", sql)
	}
	if _, ok := params[0].Value.(string); !ok {
		t.Fatalf("dim filter value should stay string, got %#v", params[0].Value)
	}
}

// 维度与指标同时过滤时，WHERE 与 HAVING 应共存且参数编号不冲突。
func TestBuildMixedDimAndMetricFilters(t *testing.T) {
	spec := baseSpec()
	spec.Filter = &FilterNode{
		Logic: "and",
		Children: []FilterNode{
			{Field: "city", Op: "=", Value: "北京"},
			{Field: "cost", Op: ">=", Value: "500"},
		},
	}
	sql, params, err := Build(spec)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(sql, "WHERE city_code = {p0:String}") ||
		!strings.Contains(sql, "HAVING `cost` >= {p1:Float64}") {
		t.Fatalf("unexpected sql:\n%s", sql)
	}
	if len(params) != 2 {
		t.Fatalf("unexpected params: %+v", params)
	}
}

// 指标过滤的值不是数字时（比如写错了），退化为 String 参数，
// 由 ClickHouse 报错，而不是在组装阶段就崩掉。
func TestBuildMetricFilterNonNumeric(t *testing.T) {
	spec := baseSpec()
	spec.Filter = &FilterNode{Logic: "and", Children: []FilterNode{{Field: "cost", Op: "=", Value: "abc"}}}
	sql, params, err := Build(spec)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(sql, "HAVING `cost` = {p0:String}") {
		t.Fatalf("unexpected sql:\n%s", sql)
	}
	if _, ok := params[0].Value.(string); !ok {
		t.Fatalf("non numeric value should stay string, got %#v", params[0].Value)
	}
}

func TestBuildMetricInFilter(t *testing.T) {
	spec := baseSpec()
	spec.Filter = &FilterNode{Logic: "and", Children: []FilterNode{{Field: "cost", Op: "in", Values: []string{"100", "200"}}}}
	sql, params, err := Build(spec)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(sql, "HAVING `cost` in ({p0:Array(Float64)})") {
		t.Fatalf("unexpected sql:\n%s", sql)
	}
	vals, ok := params[0].Value.([]float64)
	if !ok || len(vals) != 2 || vals[0] != 100 {
		t.Fatalf("unexpected param value: %#v", params[0].Value)
	}
}

// 回归：当指标 key 与聚合表达式里的列名同名时（click -> sum(clicks)），
// 若该指标同时被选中，HAVING 必须用别名，否则 ClickHouse 会判定为
// 聚合函数嵌套聚合函数。
func TestBuildMetricFilterUsesAliasWhenSelected(t *testing.T) {
	spec := baseSpec()
	spec.Metrics = []string{"click"}
	spec.Filter = &FilterNode{Logic: "and", Children: []FilterNode{{Field: "click", Op: ">", Value: "100"}}}
	sql, _, err := Build(spec)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(sql, "HAVING `click` > {p0:Float64}") {
		t.Fatalf("expected HAVING to reference alias, got:\n%s", sql)
	}
	if strings.Contains(sql, "HAVING sum(clicks)") {
		t.Fatalf("HAVING must not repeat the aggregate expression:\n%s", sql)
	}
}

// 未勾选的指标不允许用于过滤：它不会出现在结果里，拿它过滤用户看不到依据。
func TestBuildMetricFilterRejectsUnselectedMetric(t *testing.T) {
	spec := baseSpec()
	spec.Metrics = []string{"cost"}
	spec.Filter = &FilterNode{Logic: "and", Children: []FilterNode{{Field: "click", Op: ">", Value: "100"}}}
	_, _, err := Build(spec)
	if err == nil {
		t.Fatal("expected error when filtering on an unselected metric")
	}
	if !strings.Contains(err.Error(), "未被勾选") {
		t.Fatalf("unexpected error: %v", err)
	}
}

// 勾选了多个指标时，各自都能作为过滤字段。
func TestBuildMetricFilterOnSecondSelectedMetric(t *testing.T) {
	spec := baseSpec()
	spec.Metrics = []string{"cost", "click"}
	spec.Filter = &FilterNode{Logic: "and", Children: []FilterNode{{Field: "click", Op: ">", Value: "100"}}}
	sql, _, err := Build(spec)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(sql, "HAVING `click` > {p0:Float64}") {
		t.Fatalf("unexpected sql:\n%s", sql)
	}
}

// ---------- 条件树：AND / OR 组合 ----------

// 纯维度 OR：整组下压到 WHERE。
func TestBuildTreeOrDimsGoesToWhere(t *testing.T) {
	spec := baseSpec()
	spec.Filter = &FilterNode{
		Logic: "or",
		Children: []FilterNode{
			{Field: "city", Op: "=", Value: "北京"},
			{Field: "city", Op: "=", Value: "上海"},
		},
	}
	sql, params, err := Build(spec)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(sql, "WHERE (city_code = {p0:String} OR city_code = {p1:String})") {
		t.Fatalf("unexpected sql:\n%s", sql)
	}
	if strings.Contains(sql, "HAVING") {
		t.Fatalf("dim-only OR should stay in WHERE:\n%s", sql)
	}
	if len(params) != 2 {
		t.Fatalf("unexpected params: %+v", params)
	}
}

// 纯指标 OR：整组进 HAVING。
func TestBuildTreeOrMetricsGoesToHaving(t *testing.T) {
	spec := baseSpec()
	spec.Metrics = []string{"cost", "click"}
	spec.Filter = &FilterNode{
		Logic: "or",
		Children: []FilterNode{
			{Field: "cost", Op: ">", Value: "100"},
			{Field: "click", Op: "<", Value: "200"},
		},
	}
	sql, params, err := Build(spec)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(sql, "HAVING (`cost` > {p0:Float64} OR `click` < {p1:Float64})") {
		t.Fatalf("unexpected sql:\n%s", sql)
	}
	if strings.Contains(sql, "WHERE") {
		t.Fatalf("metric-only OR should stay in HAVING:\n%s", sql)
	}
	if len(params) != 2 {
		t.Fatalf("unexpected params: %+v", params)
	}
}

// 嵌套：维度 AND (指标 OR 指标) —— AND 被拆成 WHERE 与 HAVING 两段。
func TestBuildTreeNestedAndOrSplitsTwoClauses(t *testing.T) {
	spec := baseSpec()
	spec.Metrics = []string{"cost", "click"}
	spec.Filter = &FilterNode{
		Logic: "and",
		Children: []FilterNode{
			{Field: "city", Op: "=", Value: "北京"},
			{
				Logic: "or",
				Children: []FilterNode{
					{Field: "cost", Op: ">", Value: "100"},
					{Field: "click", Op: "<", Value: "200"},
				},
			},
		},
	}
	sql, _, err := Build(spec)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(sql, "WHERE city_code = {p0:String}") {
		t.Fatalf("dim condition should be pushed down:\n%s", sql)
	}
	if !strings.Contains(sql, "HAVING (`cost` > {p1:Float64} OR `click` < {p2:Float64})") {
		t.Fatalf("metric OR should land in HAVING:\n%s", sql)
	}
}

// 已勾选的维度在聚合后仍有这一列，所以可以和指标用 OR 组合（整体进 HAVING）。
func TestBuildTreeOrSelectedDimWithMetric(t *testing.T) {
	spec := baseSpec()
	spec.Filter = &FilterNode{
		Logic: "or",
		Children: []FilterNode{
			{Field: "date", Op: "=", Value: "2026-01-01"},
			{Field: "cost", Op: ">", Value: "100"},
		},
	}
	sql, _, err := Build(spec)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(sql, "HAVING (`date` = {p0:String} OR `cost` > {p1:Float64})") {
		t.Fatalf("unexpected sql:\n%s", sql)
	}
}

// 未勾选的维度只在聚合前有意义，不能和指标用 OR 连接——必须明确报错。
func TestBuildTreeRejectsOrBetweenUnselectedDimAndMetric(t *testing.T) {
	spec := baseSpec()
	spec.Filter = &FilterNode{
		Logic: "or",
		Children: []FilterNode{
			{Field: "city", Op: "=", Value: "北京"},
			{Field: "cost", Op: ">", Value: "100"},
		},
	}
	_, _, err := Build(spec)
	if err == nil {
		t.Fatal("expected error when OR mixes an unselected dim with a metric")
	}
	if !strings.Contains(err.Error(), "不能用 OR 连接") {
		t.Fatalf("unexpected error: %v", err)
	}
}

// 不支持的逻辑运算符要挡住。
func TestBuildTreeRejectsUnknownLogic(t *testing.T) {
	spec := baseSpec()
	spec.Filter = &FilterNode{
		Logic: "xor",
		Children: []FilterNode{
			{Field: "city", Op: "=", Value: "北京"},
		},
	}
	_, _, err := Build(spec)
	if err == nil || !strings.Contains(err.Error(), "不支持的逻辑运算符") {
		t.Fatalf("unexpected error: %v", err)
	}
}

// 行级权限条件必须恒以 AND 追加到 WHERE，且不能被用户的 OR 分组吞掉。
func TestBuildRowFilterAppendedToWhereWithAnd(t *testing.T) {
	spec := baseSpec()
	spec.RowFilters = []RowFilter{{Expr: "tenant_code", Values: []string{"t1", "t2"}}}
	sql, params, err := Build(spec)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(sql, "WHERE tenant_code IN ({rf0:Array(String)})") {
		t.Fatalf("row filter should land in WHERE:\n%s", sql)
	}
	if len(params) != 1 {
		t.Fatalf("unexpected params: %+v", params)
	}
	if got, ok := params[0].Value.([]string); !ok || len(got) != 2 {
		t.Fatalf("unexpected param value: %#v", params[0].Value)
	}
}

// 用户条件树的根是 OR 时，行级权限仍要以 AND 挂在最外层。
func TestBuildRowFilterNotSwallowedByUserOrGroup(t *testing.T) {
	spec := baseSpec()
	spec.Filter = &FilterNode{
		Logic: "or",
		Children: []FilterNode{
			{Field: "city", Op: "=", Value: "北京"},
			{Field: "city", Op: "=", Value: "上海"},
		},
	}
	spec.RowFilters = []RowFilter{{Expr: "tenant_code", Values: []string{"t1"}}}
	sql, _, err := Build(spec)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// 期望形态：WHERE (city_code = ... OR city_code = ...) AND tenant_code IN (...)
	if !strings.Contains(sql, "AND tenant_code IN ({rf0:Array(String)})") {
		t.Fatalf("row filter must be AND-ed outside the OR group:\n%s", sql)
	}
}

// 登录态列表为空 = 一行都不匹配（fail-closed），不能退化成不过滤。
func TestBuildRowFilterEmptyValuesStillFilters(t *testing.T) {
	spec := baseSpec()
	spec.RowFilters = []RowFilter{{Expr: "tenant_code", Values: nil}}
	sql, params, err := Build(spec)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(sql, "tenant_code IN ({rf0:Array(String)})") {
		t.Fatalf("empty value list must still emit the IN condition:\n%s", sql)
	}
	if got, ok := params[0].Value.([]string); !ok || len(got) != 0 {
		t.Fatalf("expected empty slice, got %#v", params[0].Value)
	}
}

// dim-values 同样要注入行级权限，否则下拉会把别人的取值枚举出来。
func TestBuildDimValuesSQLInjectsRowFilter(t *testing.T) {
	sql, params := BuildDimValuesSQL("select city_code from t", "city_code", 500,
		[]RowFilter{{Expr: "tenant_code", Values: []string{"t1"}}})
	if !strings.Contains(sql, "AND tenant_code IN ({rf0:Array(String)})") {
		t.Fatalf("dim-values should inject row filter:\n%s", sql)
	}
	if len(params) != 1 {
		t.Fatalf("unexpected params: %+v", params)
	}
}

// 空分组没有意义，直接拒绝。
func TestBuildTreeRejectsEmptyGroup(t *testing.T) {
	spec := baseSpec()
	spec.Filter = &FilterNode{Logic: "and"}
	_, _, err := Build(spec)
	if err == nil || !strings.Contains(err.Error(), "至少需要一个条件") {
		t.Fatalf("unexpected error: %v", err)
	}
}

// 条件树是递归结构，必须有规模上限，否则深嵌套会把组装和解析都拖垮。
func TestBuildTreeDepthLimit(t *testing.T) {
	nested := func(depth int) FilterNode {
		node := FilterNode{Field: "city", Op: "=", Value: "北京"}
		for i := 0; i < depth; i++ {
			node = FilterNode{Logic: "and", Children: []FilterNode{node}}
		}
		return node
	}
	spec := baseSpec()
	ok := nested(4)
	spec.Filter = &ok
	if _, _, err := Build(spec); err != nil {
		t.Fatalf("4 levels of nesting should be allowed: %v", err)
	}

	spec = baseSpec()
	tooDeep := nested(5)
	spec.Filter = &tooDeep
	if _, _, err := Build(spec); err == nil || !strings.Contains(err.Error(), "嵌套超过") {
		t.Fatalf("expected depth limit error, got: %v", err)
	}
}

// 叶子节点缺少 field 时给出明确错误。
func TestBuildTreeRejectsLeafWithoutField(t *testing.T) {
	spec := baseSpec()
	spec.Filter = &FilterNode{
		Logic:    "and",
		Children: []FilterNode{{Op: "=", Value: "北京"}},
	}
	_, _, err := Build(spec)
	if err == nil || !strings.Contains(err.Error(), "缺少 field") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestBuildMetricFilterRejectsLike(t *testing.T) {
	spec := baseSpec()
	spec.Filter = &FilterNode{Logic: "and", Children: []FilterNode{{Field: "cost", Op: "like", Value: "25%"}}}
	_, _, err := Build(spec)
	if err == nil {
		t.Fatal("expected error for like on metric")
	}
	if !strings.Contains(err.Error(), "指标过滤不支持操作符") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestBuildDimFilterStillAllowsLike(t *testing.T) {
	spec := baseSpec()
	spec.Filter = &FilterNode{Logic: "and", Children: []FilterNode{{Field: "city", Op: "like", Value: "杭%"}}}
	sql, _, err := Build(spec)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(sql, "WHERE city_code like {p0:String}") {
		t.Fatalf("unexpected sql:\n%s", sql)
	}
}

func TestBuildDimValuesSQL(t *testing.T) {
	sql, params := BuildDimValuesSQL("select city_code from t", "city_code", 500, nil)
	if !strings.Contains(sql, "SELECT DISTINCT city_code AS value") || !strings.Contains(sql, "LIMIT 500") {
		t.Fatalf("unexpected sql: %s", sql)
	}
	if len(params) != 0 {
		t.Fatalf("no row filter should produce no params, got %+v", params)
	}
}
