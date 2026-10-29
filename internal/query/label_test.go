package query

import "testing"

// mergeLabels 的三态语义是全局字典里最容易出错的一环：
// 「覆盖层没有这个 key」「覆盖层是空串」在 Go 里都能取到值，必须靠 ok 区分。
// 这里把四种情况全部钉死，避免以后有人顺手改成 if v := override[k]; v == "" 而静默破坏语义。
func TestMergeLabels(t *testing.T) {
	dims := map[string]string{"city": "city", "channel": "channel"}
	mtxs := map[string]string{"cost": "sum(x)"}
	global := map[string]string{"city": "城市", "cost": "消耗", "channel": "渠道"}

	t.Run("没有覆盖时继承全局", func(t *testing.T) {
		got := mergeLabels(dims, nil, mtxs, map[string]string{}, global)
		want := map[string]string{"city": "城市", "channel": "渠道", "cost": "消耗"}
		assertMapEqual(t, got, want)
	})

	t.Run("覆盖优先于全局", func(t *testing.T) {
		got := mergeLabels(dims, nil, mtxs, map[string]string{"channel": "广告位"}, global)
		if got["channel"] != "广告位" {
			t.Fatalf("channel = %q, want 覆盖值 广告位", got["channel"])
		}
		// 其余字段仍然继承
		if got["city"] != "城市" || got["cost"] != "消耗" {
			t.Fatalf("继承被破坏: %v", got)
		}
	})

	t.Run("显式空串不继承全局", func(t *testing.T) {
		got := mergeLabels(dims, nil, mtxs, map[string]string{"channel": ""}, global)
		if _, ok := got["channel"]; ok {
			t.Fatalf("channel 显式留空时不应产出中文名，got %q", got["channel"])
		}
	})

	t.Run("全局没有定义时只保留覆盖", func(t *testing.T) {
		got := mergeLabels(dims, nil, mtxs, map[string]string{"city": "地级市"}, nil)
		assertMapEqual(t, got, map[string]string{"city": "地级市"})
	})

	t.Run("只为真实存在的列生成名字", func(t *testing.T) {
		// 全局字典里跟本数据集无关的字段不能混进表头
		got := mergeLabels(dims, nil, mtxs, map[string]string{}, map[string]string{"city": "城市", "unknown": "无关字段"})
		if _, ok := got["unknown"]; ok {
			t.Fatalf("不应输出与本数据集无关的字段: %v", got)
		}
	})

	t.Run("多值维度与普通维度共用一套命名", func(t *testing.T) {
		// 它只是聚合方式不同，身份仍然是维度，中文名规则不该有区别
		got := mergeLabels(dims, map[string]string{"companies": "companies"}, mtxs,
			map[string]string{}, map[string]string{"companies": "所属公司"})
		if got["companies"] != "所属公司" {
			t.Fatalf("companies = %q, want 所属公司; got %v", got["companies"], got)
		}
	})

	t.Run("空输入不炸", func(t *testing.T) {
		got := mergeLabels(nil, nil, nil, nil, nil)
		if len(got) != 0 {
			t.Fatalf("want empty, got %v", got)
		}
	})
}

func assertMapEqual(t *testing.T, got, want map[string]string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("len = %d, want %d; got %v", len(got), len(want), got)
	}
	for k, v := range want {
		if got[k] != v {
			t.Fatalf("%s = %q, want %q; got %v", k, got[k], v, got)
		}
	}
}
