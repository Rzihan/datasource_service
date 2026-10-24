package query

import (
	"strings"
	"testing"
)

// 一个贴近真实用法的模板：三张维表，各自的保留条件不同
const multiJoinTmpl = `select
  f.stat_date as stat_date,
  f.stat_cost as stat_cost
  {{ if .HasAny "city_name" "city_tier" }}
  , c.city_name as city_name, c.city_tier as city_tier
  {{ end }}
  {{ if .Has "shop_name" }}
  , s.shop_name as shop_name
  {{ end }}
from demo.t_order_dtl f
{{ if .HasAny "city_name" "city_tier" }}
  left join dim_city c on f.city_code = c.city_code
{{ end }}
{{ if .Has "shop_name" }}
  left join dim_shop s on f.shop_id = s.shop_id
{{ end }}
{{ if and (.HasAll "brand_name" "shop_name") }}
  left join dim_brand b on s.brand_id = b.brand_id
{{ end }}`

func TestRenderMidSQLNoTemplate(t *testing.T) {
	// 存量配置不含模板语法：原样返回，零开销
	in := "select a, b from t where c = 1"
	out, err := RenderMidSQL(in, MidSQLData{Fields: []string{"a"}})
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if out != in {
		t.Fatalf("expected passthrough, got %q", out)
	}
}

func TestRenderMidSQLPrunesUnusedJoin(t *testing.T) {
	cases := []struct {
		name    string
		data    MidSQLData
		want    []string
		notWant []string
	}{
		{
			name:    "只查消耗：三张维表全裁掉",
			data:    MidSQLData{Metrics: []string{"cost"}, Fields: []string{"cost", "stat_date"}},
			want:    []string{"from demo.t_order_dtl f"},
			notWant: []string{"dim_city", "dim_shop", "dim_brand", "city_name"},
		},
		{
			name:    "用到城市维度：只保留城市维表",
			data:    MidSQLData{Dims: []string{"city_name"}, Fields: []string{"city_name", "cost"}},
			want:    []string{"left join dim_city c", "c.city_name as city_name"},
			notWant: []string{"dim_shop", "dim_brand"},
		},
		{
			name:    "用到店铺维度：只保留店铺维表",
			data:    MidSQLData{Dims: []string{"shop_name"}, Fields: []string{"shop_name", "cost"}},
			want:    []string{"left join dim_shop s", "s.shop_name as shop_name"},
			notWant: []string{"dim_city", "dim_brand"},
		},
		{
			name: "品牌+店铺都在：品牌维表也要",
			data: MidSQLData{
				Dims:   []string{"shop_name", "brand_name"},
				Fields: []string{"brand_name", "shop_name"},
			},
			want: []string{"left join dim_shop s", "left join dim_brand b"},
		},
		{
			name:    "只有品牌没有店铺：HasAll 不成立，品牌维表不 join",
			data:    MidSQLData{Dims: []string{"brand_name"}, Fields: []string{"brand_name"}},
			notWant: []string{"dim_brand", "dim_shop"},
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			out, err := RenderMidSQL(multiJoinTmpl, c.data)
			if err != nil {
				t.Fatalf("render: %v", err)
			}
			for _, w := range c.want {
				if !strings.Contains(out, w) {
					t.Errorf("期望包含 %q，实际：\n%s", w, out)
				}
			}
			for _, n := range c.notWant {
				if strings.Contains(out, n) {
					t.Errorf("期望不包含 %q，实际：\n%s", n, out)
				}
			}
		})
	}
}

func TestRenderMidSQLFuncMap(t *testing.T) {
	// hasAny/hasAll 两种传参都支持：传 . 或传 .Fields
	for _, tmpl := range []string{
		`{{ if hasAny . "a" "b" }}yes{{ end }}{{ if hasAll . "a" "b" }}all{{ end }}` +
			`{{ if hasDim . "d1" }}dim{{ end }}{{ if hasMetric . "m1" }}mtx{{ end }}`,
		`{{ if hasAny .Fields "a" "b" }}yes{{ end }}{{ if hasAll .Fields "a" "b" }}all{{ end }}` +
			`{{ if .HasDim "d1" }}dim{{ end }}{{ if .HasMetric "m1" }}mtx{{ end }}`,
	} {
		data := MidSQLData{Dims: []string{"d1"}, Metrics: []string{"m1"}, Fields: []string{"a", "d1", "m1"}}
		out, err := RenderMidSQL(tmpl, data)
		if err != nil {
			t.Fatalf("render: %v", err)
		}
		// hasAny(a,b) 命中 a → yes；hasAll(a,b) 缺 b → 不输出 all
		if out != "yesdimmtx" {
			t.Fatalf("got %q", out)
		}
	}
}

func TestRenderMidSQLSyntaxError(t *testing.T) {
	if _, err := RenderMidSQL("select {{ if }}", MidSQLData{}); err == nil {
		t.Fatal("期望模板语法错误")
	}
}

func TestRenderMidSQLMissingKeyErrors(t *testing.T) {
	// 引用不存在的变量要报错，而不是静默渲染出 <no value>
	if _, err := RenderMidSQL("select {{ .Nope }}", MidSQLData{}); err == nil {
		t.Fatal("期望 missingkey 报错")
	}
}

func TestRenderMidSQLSizeLimit(t *testing.T) {
	// range 写错导致输出爆炸时要被拦住
	tmpl := `{{ range $i := .Fields }}aaaaaaaaaa{{ end }}`
	data := MidSQLData{Fields: make([]string, 200000)}
	if _, err := RenderMidSQL(tmpl, data); err == nil {
		t.Fatal("期望触发输出长度上限")
	}
}

func TestBuildFieldsIncludesRowFilterColumn(t *testing.T) {
	got := buildFields([]string{"city"}, []string{"cost"}, []string{"channel"}, []string{"tenant"})
	want := []string{"channel", "city", "cost", "tenant"}
	if len(got) != len(want) {
		t.Fatalf("got %v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v want %v", got, want)
		}
	}
}

func TestBuildFieldsDedupAndStable(t *testing.T) {
	a := buildFields([]string{"b", "a"}, []string{"a"}, nil, nil)
	b := buildFields([]string{"a", "b"}, []string{"a"}, nil, nil)
	if len(a) != 2 || a[0] != "a" || a[1] != "b" {
		t.Fatalf("unexpected %v", a)
	}
	if strings.Join(a, ",") != strings.Join(b, ",") {
		t.Fatalf("顺序不稳定：%v vs %v", a, b)
	}
}
