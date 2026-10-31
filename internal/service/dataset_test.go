package service

import (
	"context"
	"errors"
	"strings"
	"testing"

	"dataset_service/internal/model"
)

func TestNormalizeKey(t *testing.T) {
	cases := []struct {
		in      string
		want    string
		wantErr bool
	}{
		{in: "order_daily", want: "order_daily"},
		{in: " Order_Daily ", want: "order_daily"}, // 去空白 + 强制小写
		{in: "order.daily-1", want: "order.daily-1"},
		{in: "", wantErr: true},
		{in: "a", wantErr: true},           // 太短
		{in: "_order", wantErr: true},      // 下划线开头不允许
		{in: "order daily", wantErr: true}, // 含空格
		{in: strings.Repeat("a", 70), wantErr: true},
	}
	for _, c := range cases {
		got, err := normalizeKey(c.in)
		if c.wantErr {
			if err == nil {
				t.Fatalf("normalizeKey(%q) expected error, got nil", c.in)
			}
			if !errors.Is(err, ErrInvalid) {
				t.Fatalf("normalizeKey(%q) error should wrap ErrInvalid, got %v", c.in, err)
			}
			continue
		}
		if err != nil {
			t.Fatalf("normalizeKey(%q) unexpected error: %v", c.in, err)
		}
		if got != c.want {
			t.Fatalf("normalizeKey(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestCheckMidSQLLength(t *testing.T) {
	svc := NewDatasetService(nil, 100)
	if err := svc.checkMidSQL("select 1"); err != nil {
		t.Fatalf("short sql should pass: %v", err)
	}
	if err := svc.checkMidSQL("   "); err == nil {
		t.Fatal("blank sql should fail")
	}
	if err := svc.checkMidSQL(strings.Repeat("a", 101)); err == nil {
		t.Fatal("oversized sql should fail")
	}
}

func TestNormalizeStringMap(t *testing.T) {
	got, err := normalizeStringMap(nil, "dim_map")
	if err != nil || got == nil || len(got) != 0 {
		t.Fatalf("nil map should normalize to empty map, got %v err %v", got, err)
	}

	got, err = normalizeStringMap(map[string]string{"cost": "sum(cost)"}, "mtx_map")
	if err != nil || got["cost"] != "sum(cost)" {
		t.Fatalf("valid map rejected: %v err %v", got, err)
	}

	if _, err = normalizeStringMap(map[string]string{"  ": "x"}, "dim_map"); err == nil {
		t.Fatal("empty key should fail")
	}
	if _, err = normalizeStringMap(map[string]string{" cost": "x"}, "dim_map"); err == nil {
		t.Fatal("key with leading whitespace should fail")
	}
}

func TestNormalizeACL(t *testing.T) {
	dimMap := map[string]string{"stat_date": "stat_date", "city": "city_code"}
	mtxMap := map[string]string{"cost": "sum(stat_cost)"}

	got, err := normalizeACL(model.ACL{
		Tenants:    []string{" t2 ", "t1", "t1", ""},
		ColTenants: map[string][]string{"cost": {"t1"}, "stat_date": {"t1", " t1 ", ""}},
	}, dimMap, nil, mtxMap)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// 去空白 + 去重 + 排序
	if len(got.Tenants) != 2 || got.Tenants[0] != "t1" || got.Tenants[1] != "t2" {
		t.Fatalf("unexpected tenants: %v", got.Tenants)
	}
	if len(got.ColTenants["stat_date"]) != 1 || got.ColTenants["stat_date"][0] != "t1" {
		t.Fatalf("unexpected col_tenants: %v", got.ColTenants)
	}

	// 空列表等价于「不限制」，直接不落这一项
	got, err = normalizeACL(model.ACL{ColTenants: map[string][]string{"cost": {}}}, dimMap, nil, mtxMap)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if _, ok := got.ColTenants["cost"]; ok {
		t.Fatalf("empty whitelist should be dropped, got %v", got.ColTenants)
	}
}

// 维度键与指标键都可以作为 col_tenants 的 key。
func TestNormalizeACLAllowsDimOrMtxKey(t *testing.T) {
	dimMap := map[string]string{"stat_date": "stat_date"}
	mtxMap := map[string]string{"cost": "sum(stat_cost)"}

	if _, err := normalizeACL(model.ACL{
		ColTenants: map[string][]string{"stat_date": {"t1"}, "cost": {"t2"}},
	}, dimMap, nil, mtxMap); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

// col_tenants 拼错列名会让该列静默保持可见（权限配置 fail-open），必须挡住。
func TestNormalizeACLRejectsUnknownColumn(t *testing.T) {
	dimMap := map[string]string{"stat_date": "stat_date"}
	mtxMap := map[string]string{"cost": "sum(stat_cost)"}

	_, err := normalizeACL(model.ACL{
		ColTenants: map[string][]string{"stat_datee": {"t1"}},
	}, dimMap, nil, mtxMap)
	if err == nil {
		t.Fatal("expected error for unknown column in col_tenants")
	}
}

// Create 的入参校验失败时不应该触达数据库，这里 repo 为 nil，
// 一旦调用到 repo 会 panic，正好验证「校验先行」。
func TestCreateRejectsInvalidInputBeforeHittingRepo(t *testing.T) {
	svc := NewDatasetService(nil, 1024)
	_, err := svc.Create(context.Background(), &model.CreateRequest{
		DatasetKey:  "BAD KEY",
		DatasetName: "x",
		MidSQL:      "select 1",
	}, "tester")
	if err == nil || !errors.Is(err, ErrInvalid) {
		t.Fatalf("expected ErrInvalid, got %v", err)
	}
}

func TestNormalizeEntry(t *testing.T) {
	// key 为空 = 没挂入口，而不是挂一个空入口：菜单上会真的多出一项，比没有更糟
	if got := normalizeEntry(nil); got != nil {
		t.Fatalf("nil entry: got %+v", got)
	}
	if got := normalizeEntry(&model.DatasetEntry{Key: "  "}); got != nil {
		t.Fatalf("blank key: got %+v", got)
	}
	// 大小写混写的链接在复制传播时经常变形，而菜单链接恰恰是最常被复制的东西
	if got := normalizeEntry(&model.DatasetEntry{Key: "Collect-Daily"}); got != nil {
		t.Fatalf("uppercase key should be dropped: got %+v", got)
	}
	if got := normalizeEntry(&model.DatasetEntry{Key: "collect daily"}); got != nil {
		t.Fatalf("key with space should be dropped: got %+v", got)
	}

	got := normalizeEntry(&model.DatasetEntry{
		Key:    " collect-daily ",
		Title:  " 采集任务日报 ",
		Module: " 数据采集 ",
		Legacy: " collect_daily ",
		Status: "replaced",
		Note:   " 同一份数据 ",
		Sort:   10,
	})
	if got == nil || got.Key != "collect-daily" || got.Title != "采集任务日报" ||
		got.Module != "数据采集" || got.Legacy != "collect_daily" ||
		got.Status != model.EntryStatusReplaced || got.Note != "同一份数据" || got.Sort != 10 {
		t.Fatalf("normalize: got %+v", got)
	}

	// 状态不认识就退回并存：宁可停在观察期，也不要因为拼错一个字符串把旧页下线
	cases := map[string]string{
		"":          model.EntryStatusParallel,
		"parallel":  model.EntryStatusParallel,
		"default":   model.EntryStatusDefault,
		"replaced":  model.EntryStatusReplaced,
		"REPLACED ": model.EntryStatusParallel,
		"deleted":   model.EntryStatusParallel,
	}
	for in, want := range cases {
		if got := normalizeEntry(&model.DatasetEntry{Key: "k", Status: in}); got.Status != want {
			t.Fatalf("status %q: got %q want %q", in, got.Status, want)
		}
	}
}
