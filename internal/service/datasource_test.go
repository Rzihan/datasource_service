package service

import (
	"context"
	"errors"
	"strings"
	"testing"

	"datasource_service/internal/model"
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
	svc := NewDatasourceService(nil, 100)
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

// Create 的入参校验失败时不应该触达数据库，这里 repo 为 nil，
// 一旦调用到 repo 会 panic，正好验证「校验先行」。
func TestCreateRejectsInvalidInputBeforeHittingRepo(t *testing.T) {
	svc := NewDatasourceService(nil, 1024)
	_, err := svc.Create(context.Background(), &model.CreateRequest{
		DatasourceKey:  "BAD KEY",
		DatasourceName: "x",
		MidSQL:         "select 1",
	}, "tester")
	if err == nil || !errors.Is(err, ErrInvalid) {
		t.Fatalf("expected ErrInvalid, got %v", err)
	}
}
