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

func TestBuildDimValuesSQL(t *testing.T) {
	sql := BuildDimValuesSQL("select city_code from t", "city_code", 500)
	if !strings.Contains(sql, "SELECT DISTINCT city_code AS value") || !strings.Contains(sql, "LIMIT 500") {
		t.Fatalf("unexpected sql: %s", sql)
	}
}
