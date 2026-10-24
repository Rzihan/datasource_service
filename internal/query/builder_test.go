package query

import (
	"errors"
	"strings"
	"testing"
)

func baseSpec() Spec {
	return Spec{
		DatasourceKey: "order_daily",
		MidSQL:        "select stat_date, city_code, stat_cost, clicks from t_order_dtl",
		DimMap:        map[string]string{"date": "stat_date", "city": "city_code"},
		MtxMap:        map[string]string{"cost": "sum(stat_cost)", "click": "sum(clicks)"},
		Dims:          []string{"date"},
		Metrics:       []string{"cost"},
		MaxLimit:      10000,
		DefaultLimit:  1000,
	}
}

func TestBuildBasic(t *testing.T) {
	spec := baseSpec()
	spec.Filters = []Filter{{Field: "city", Op: "=", Value: "北京"}}
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
	spec.Filters = []Filter{{Field: "city", Op: "=", Value: "' OR 1=1 --"}}
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
	spec.Filters = []Filter{{Field: "city", Op: "in", Values: []string{"北京", "上海"}}}
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
			s.Filters = []Filter{{Field: "nope", Op: "=", Value: "x"}}
		}},
		{"非法操作符", func(s *Spec) {
			s.Filters = []Filter{{Field: "city", Op: "drop", Value: "x"}}
		}},
		{"过滤值为空", func(s *Spec) {
			s.Filters = []Filter{{Field: "city", Op: "=", Value: "  "}}
		}},
		{"in 操作缺 values", func(s *Spec) {
			s.Filters = []Filter{{Field: "city", Op: "in"}}
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
	spec.Filters = []Filter{{Field: "cost", Op: ">", Value: "1000"}}
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
	spec.Filters = []Filter{{Field: "city", Op: "=", Value: "1000"}}
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
func TestBuildMixedFilters(t *testing.T) {
	spec := baseSpec()
	spec.Filters = []Filter{
		{Field: "city", Op: "=", Value: "北京"},
		{Field: "cost", Op: ">=", Value: "500"},
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
	spec.Filters = []Filter{{Field: "cost", Op: "=", Value: "abc"}}
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
	spec.Filters = []Filter{{Field: "cost", Op: "in", Values: []string{"100", "200"}}}
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
	spec.Filters = []Filter{{Field: "click", Op: ">", Value: "100"}}
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
	spec.Filters = []Filter{{Field: "click", Op: ">", Value: "100"}}
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
	spec.Filters = []Filter{{Field: "click", Op: ">", Value: "100"}}
	sql, _, err := Build(spec)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(sql, "HAVING `click` > {p0:Float64}") {
		t.Fatalf("unexpected sql:\n%s", sql)
	}
}

func TestBuildMetricFilterRejectsLike(t *testing.T) {
	spec := baseSpec()
	spec.Filters = []Filter{{Field: "cost", Op: "like", Value: "25%"}}
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
	spec.Filters = []Filter{{Field: "city", Op: "like", Value: "杭%"}}
	sql, _, err := Build(spec)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(sql, "WHERE city_code like {p0:String}") {
		t.Fatalf("unexpected sql:\n%s", sql)
	}
}

func TestBuildDimValuesSQL(t *testing.T) {
	sql := BuildDimValuesSQL("select city_code from t", "city_code", 500)
	if !strings.Contains(sql, "SELECT DISTINCT city_code AS value") || !strings.Contains(sql, "LIMIT 500") {
		t.Fatalf("unexpected sql: %s", sql)
	}
}
