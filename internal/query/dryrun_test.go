package query

import (
	"strings"
	"testing"
)

func TestBuildDryRunSQL(t *testing.T) {
	dims := map[string]string{"date": "stat_date", "city": "city_code"}
	mtxs := map[string]string{"cost": "sum(stat_cost)"}

	sql, keys, err := BuildDryRunSQL("select 1", dims, mtxs)
	if err != nil {
		t.Fatalf("err = %v", err)
	}

	t.Run("所有字段都参与校验且有序", func(t *testing.T) {
		// 顺序固定，报错时才能稳定地对回字段
		want := []string{"city", "cost", "date"}
		if len(keys) != len(want) {
			t.Fatalf("keys = %v, want %v", keys, want)
		}
		for i := range want {
			if keys[i] != want[i] {
				t.Fatalf("keys = %v, want %v", keys, want)
			}
		}
	})

	t.Run("表达式用原样、别名用反引号包裹", func(t *testing.T) {
		if !strings.Contains(sql, "sum(stat_cost) AS `cost`") {
			t.Fatalf("表达式应原样出现并带别名，got:\n%s", sql)
		}
		if !strings.Contains(sql, "city_code AS `city`") {
			t.Fatalf("got:\n%s", sql)
		}
	})

	t.Run("只取一行", func(t *testing.T) {
		if !strings.HasSuffix(sql, "LIMIT 1") {
			t.Fatalf("自检不该拉数据，got:\n%s", sql)
		}
	})

	t.Run("有维度又有指标时必须带 GROUP BY", func(t *testing.T) {
		// 缺了它 ClickHouse 会报 "Column x is not under aggregate function"，
		// 那是自检 SQL 自己的问题，会被误当成配置写错了
		// 按维度键排序后取表达式，所以顺序是 city_code, stat_date
		if !strings.Contains(sql, "GROUP BY city_code, stat_date") {
			t.Fatalf("got:\n%s", sql)
		}
	})

	t.Run("只有指标时不加 GROUP BY", func(t *testing.T) {
		s2, _, err := BuildDryRunSQL("select 1", nil, mtxs)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(s2, "GROUP BY") {
			t.Fatalf("全表聚合不该加 GROUP BY，got:\n%s", s2)
		}
	})

	t.Run("只有维度时不加 GROUP BY", func(t *testing.T) {
		s2, _, err := BuildDryRunSQL("select 1", dims, nil)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(s2, "GROUP BY") {
			t.Fatalf("got:\n%s", s2)
		}
	})

	t.Run("末尾分号会被去掉", func(t *testing.T) {
		s2, _, err := BuildDryRunSQL("select 1;", dims, mtxs)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(s2, "select 1;") {
			t.Fatalf("分号会破坏子查询语法，got:\n%s", s2)
		}
	})
}

func TestBuildDryRunSQLErrors(t *testing.T) {
	t.Run("表达式为空要报错而不是拼出坏 SQL", func(t *testing.T) {
		_, _, err := BuildDryRunSQL("select 1", map[string]string{"cost": ""}, nil)
		if err == nil {
			t.Fatal("want error")
		}
	})

	t.Run("两个 map 都空要报错", func(t *testing.T) {
		if _, _, err := BuildDryRunSQL("select 1", nil, nil); err == nil {
			t.Fatal("want error")
		}
	})

	t.Run("同名键不会生成重复别名", func(t *testing.T) {
		sql, keys, err := BuildDryRunSQL("select 1",
			map[string]string{"cost": "stat_cost"},
			map[string]string{"cost": "sum(stat_cost)"})
		if err != nil {
			t.Fatal(err)
		}
		if len(keys) != 1 || keys[0] != "cost" {
			t.Fatalf("keys = %v", keys)
		}
		if n := strings.Count(sql, "AS `cost`"); n != 1 {
			t.Fatalf("别名应只出现一次，got %d:\n%s", n, sql)
		}
		// 指标优先：同一键在两侧都有时，以指标表达式为准
		if !strings.Contains(sql, "sum(stat_cost)") {
			t.Fatalf("got:\n%s", sql)
		}
	})
}

func TestBuildDryRunMidSQL(t *testing.T) {
	got := BuildDryRunMidSQL("select 1;")
	if !strings.HasPrefix(got, "SELECT * FROM (") {
		t.Fatalf("got: %s", got)
	}
	if strings.Contains(got, "select 1;") {
		t.Fatalf("分号未去掉: %s", got)
	}
	if !strings.HasSuffix(got, "LIMIT 1") {
		t.Fatalf("got: %s", got)
	}
}
