package service

import (
	"context"
	"testing"

	"dataset_service/internal/model"
)

// 全局字典只有「字段名」这一个维度的 key，跨数据集必然可能撞车。
// 四类问题都不会报错、只会静默显示错的名字，所以逐条钉死。
func TestCheckAgainst(t *testing.T) {
	items := []*model.DatasetConfig{
		{
			DatasetKey: "ds_a",
			DimMap:     map[string]string{"city": "city", "Cost": "cost"},
			MtxMap:     map[string]string{"cost": "sum(cost)", "clicks": "sum(clicks)"},
			LabelMap:   map[string]string{"city": "地级市", "clicks": "点击数"},
		},
		{
			DatasetKey: "ds_b",
			DimMap:     map[string]string{"city": "city"},
			MtxMap:     map[string]string{"gmv": "sum(gmv)"},
			LabelMap:   map[string]string{"gmv": ""}, // 显式空串：有意不使用中文名
		},
	}
	global := map[string]string{"city": "城市", "cost": "消耗", "uv": "去重用户数"}

	res, err := checkAgainst(context.Background(), items, global)
	if err != nil {
		t.Fatalf("checkAgainst: %v", err)
	}

	t.Run("覆盖与全局不一致算冲突", func(t *testing.T) {
		if len(res.Conflicts) != 1 {
			t.Fatalf("conflicts = %+v, want 1 条", res.Conflicts)
		}
		c := res.Conflicts[0]
		if c.FieldKey != "city" || c.GlobalLabel != "城市" {
			t.Fatalf("conflict = %+v", c)
		}
		if len(c.Overrides) != 1 || c.Overrides[0].DatasetKey != "ds_a" || c.Overrides[0].Label != "地级市" {
			t.Fatalf("overrides = %+v", c.Overrides)
		}
	})

	t.Run("大小写不匹配会被扫出来", func(t *testing.T) {
		// ds_a 的 Cost 匹配不上全局的 cost，全局定义静默失效，且没有任何报错
		if len(res.CaseMismatch) != 1 {
			t.Fatalf("case_mismatch = %+v, want 1 条", res.CaseMismatch)
		}
		m := res.CaseMismatch[0]
		if m.DatasetKey != "ds_a" || m.FieldKey != "Cost" || m.GlobalKey != "cost" || m.GlobalLabel != "消耗" {
			t.Fatalf("case_mismatch = %+v", m)
		}
	})

	t.Run("显式空串不算缺失", func(t *testing.T) {
		// gmv 在 ds_b 里被显式留空，是有意为之，不该报「缺中文名」
		for _, m := range res.Missing {
			if m.FieldKey == "gmv" {
				t.Fatalf("gmv 是显式留空，不应计入缺失: %+v", res.Missing)
			}
		}
	})

	t.Run("有覆盖的字段不算缺失", func(t *testing.T) {
		// clicks 有数据集自己的覆盖「点击数」，虽然全局没有，也不该算缺失
		for _, m := range res.Missing {
			if m.FieldKey == "clicks" {
				t.Fatalf("clicks 有覆盖，不应计入缺失: %+v", res.Missing)
			}
		}
	})

	t.Run("没人引用的全局定义算孤儿", func(t *testing.T) {
		if len(res.Orphans) != 1 || res.Orphans[0].FieldKey != "uv" {
			t.Fatalf("orphans = %+v, want 只有 uv", res.Orphans)
		}
	})

	t.Run("空输入不炸", func(t *testing.T) {
		got, err := checkAgainst(context.Background(), nil, nil)
		if err != nil {
			t.Fatalf("err = %v", err)
		}
		if len(got.Conflicts) != 0 || len(got.Missing) != 0 || len(got.Orphans) != 0 {
			t.Fatalf("want empty, got %+v", got)
		}
	})
}
