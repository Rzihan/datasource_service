package query

import (
	"strings"
	"testing"
)

// 扫描的两条判据各测一遍，以及「都不命中就不列」——
// 宁可漏报也不要满屏误报，误报多了这个面板就没人看了。
func TestArrayFieldReason(t *testing.T) {
	colTypes := map[string]string{
		"companies": "Array(String)",
		"city_code": "String",
		"tags":      "Array(Nullable(String))",
	}

	cases := []struct {
		name string
		expr string
		want string
	}{
		{"底层列是数组", "companies", "数组类型"},
		{"底层列是普通字符串", "city_code", ""},
		{"Nullable 元素的数组也算", "tags", "数组类型"},
		{"表达式用了数组函数", "arrayStringConcat(groupUniqArrayArray(companies), ',')", "数组函数"},
		{"groupArray 也算", "groupArray(x)", "数组函数"},
		{"arrayJoin 也算", "arrayJoin(tags)", "数组函数"},
		{"普通聚合不算", "sum(stat_cost)", ""},
		{"普通列改造不算", "toDate(ts)", ""},
		{"列名在输出里找不到时退到正则", "groupUniqArray(unknown_col)", "数组函数"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := arrayFieldReason(c.expr, colTypes)
			if c.want == "" {
				if got != "" {
					t.Fatalf("expr %q: got %q, want 不列为候选", c.expr, got)
				}
				return
			}
			if !strings.Contains(got, c.want) {
				t.Fatalf("expr %q: got %q, want 含 %q", c.expr, got, c.want)
			}
		})
	}
}

// 长函数名不能被短的同前缀分支吃掉：groupArray 先匹配上的话，
// groupUniqArrayArray 会被判成「数组函数」——碰巧结论一样，
// 但 arrayStringConcat 这类只有长名才有的必须真的匹配上。
func TestArrayFuncPatternMatchesLongNames(t *testing.T) {
	for _, e := range []string{
		"groupUniqArrayArray(x)",
		"groupUniqArray(x)",
		"groupArray(x)",
		"arrayStringConcat(x)",
		"arrayDistinct(x)",
		"arrayJoin(x)",
		"GROUPUNIQARRAYARRAY(x)", // 大小写不敏感：配置里大小写混用很常见
	} {
		if !arrayFuncPattern.MatchString(e) {
			t.Fatalf("%q 应命中数组函数判据", e)
		}
	}
	for _, e := range []string{"sum(x)", "uniq(x)", "toDate(ts)", "cost"} {
		if arrayFuncPattern.MatchString(e) {
			t.Fatalf("%q 不该命中数组函数判据", e)
		}
	}
}

// 剥壳是整个迁移能否成功的关键：以前写在 mtx_map 里的多是完整收拢式，
// 原样搬过去会被再包一层收拢，变成对字符串做 groupUniqArrayArray。
func TestStripCollectShell(t *testing.T) {
	cases := []struct {
		name string
		expr string
		want string
	}{
		{"完整收拢式", "arrayStringConcat(arraySort(groupUniqArrayArray(companies)), ',')", "companies"},
		{"没排序的收拢式", "arrayStringConcat(groupUniqArrayArray(companies), ',')", "companies"},
		{"只有聚合函数", "groupUniqArrayArray(companies)", "companies"},
		{"groupArray 也要剥", "arrayStringConcat(arrayDistinct(groupArray(tags)), '|')", "tags"},
		{"本来就是裸数组列", "companies", "companies"},
		{"不是调用就原样返回", "toDate(ts)", "toDate(ts)"},
		{"调用不是整个表达式时不剥", "concat(arrayStringConcat(x, ','), '!')", "concat(arrayStringConcat(x, ','), '!')"},
		{"分隔符里的括号不该影响配对", "arrayStringConcat(groupUniqArrayArray(x), '()')", "x"},
		{"转义引号里的逗号不该被当成参数分隔", `arrayStringConcat(groupUniqArrayArray(x), '\'')`, "x"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := stripCollectShell(c.expr); got != c.want {
				t.Fatalf("got %q, want %q", got, c.want)
			}
		})
	}
}

// 只有能确认「建议表达式真的产出数组」才给一键迁移。
// 猜错了比不迁更糟——配错之后下次查询才炸，排查成本更高。
func TestScanMultiDimConfidence(t *testing.T) {
	colTypes := map[string]string{"companies": "Array(String)", "city": "String"}

	t.Run("剥壳后确认是数组列才给迁移", func(t *testing.T) {
		got := scanMultiDim("ds1",
			map[string]string{"c": "arrayStringConcat(arraySort(groupUniqArrayArray(companies)), ',')"},
			"mtx_map", colTypes)
		if len(got) != 1 {
			t.Fatalf("got %+v", got)
		}
		if got[0].SuggestExpr != "companies" || !got[0].Confident {
			t.Fatalf("got %+v", got[0])
		}
	})

	t.Run("剥壳后不是数组列就不给迁移", func(t *testing.T) {
		// groupArray(city) 是「收集所有城市」的指标，是真指标不是多值维度。
		// 剥成 city 之后它不是数组，不该提供一键迁移。
		got := scanMultiDim("ds1", map[string]string{"cities": "groupArray(city)"}, "mtx_map", colTypes)
		if len(got) != 1 {
			t.Fatalf("got %+v", got)
		}
		if got[0].Confident {
			t.Fatalf("不该给一键迁移: %+v", got[0])
		}
	})

	t.Run("裸数组列直接给迁移", func(t *testing.T) {
		got := scanMultiDim("ds1", map[string]string{"c": "companies"}, "dim_map", colTypes)
		if len(got) != 1 || !got[0].Confident || got[0].SuggestExpr != "companies" {
			t.Fatalf("got %+v", got)
		}
	})
}

func TestScanMultiDim(t *testing.T) {
	colTypes := map[string]string{"companies": "Array(String)", "city": "String"}

	t.Run("指标里的多值字段会列出来", func(t *testing.T) {
		got := scanMultiDim("ds1", map[string]string{"company": "companies", "cost": "sum(x)"}, "mtx_map", colTypes)
		if len(got) != 1 || got[0].FieldKey != "company" || got[0].From != "mtx_map" {
			t.Fatalf("got %+v", got)
		}
	})

	t.Run("普通维度里的多值字段要额外说明会拆行", func(t *testing.T) {
		got := scanMultiDim("ds1", map[string]string{"company": "companies"}, "dim_map", colTypes)
		if len(got) != 1 {
			t.Fatalf("got %+v", got)
		}
		if !strings.Contains(got[0].Reason, "拆成多行") {
			t.Fatalf("理由里应点明会拆行，got %q", got[0].Reason)
		}
	})

	t.Run("没有可疑字段时返回空", func(t *testing.T) {
		got := scanMultiDim("ds1", map[string]string{"city": "city", "cost": "sum(x)"}, "mtx_map", colTypes)
		if len(got) != 0 {
			t.Fatalf("got %+v", got)
		}
	})
}
