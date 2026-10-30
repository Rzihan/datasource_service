package service

import (
	"errors"
	"testing"

	"dataset_service/internal/model"
)

func TestNormalizePanels(t *testing.T) {
	got := normalizePanels([]model.DashboardPanel{
		// 没有数据集：跑不出数，在大盘上就是一个永远转圈的方块
		{ID: "x1", Title: "空面板", View: "line"},
		// 视图不认识 → 退回表格。表格是唯一「任何查询都能画出来」的形态
		{ID: "a", Dataset: "ds", View: "雷达图", Span: 99, Height: 5},
		{ID: "a", Dataset: "ds", View: "metric", Span: 3, Height: 150}, // id 重复
		{Dataset: "ds", View: "column", Span: 6},                       // id 为空
	})
	if len(got) != 3 {
		t.Fatalf("panel without dataset should be dropped: got %d %+v", len(got), got)
	}
	if got[0].View != model.PanelViewTable {
		t.Fatalf("unknown view should fall back to table: got %q", got[0].View)
	}
	if got[0].Span != 6 || got[0].Height != 260 {
		t.Fatalf("span/height should be clamped: got span=%d height=%d", got[0].Span, got[0].Height)
	}
	// 重复的 id 与空 id 都要被补成唯一的：用数组下标当身份时，
	// 删掉中间一个面板会让后面所有面板的编辑状态集体错位。
	ids := map[string]bool{}
	for _, p := range got {
		if p.ID == "" || ids[p.ID] {
			t.Fatalf("panel id must be unique and non-empty: %+v", got)
		}
		ids[p.ID] = true
	}
	if got[0].ID != "a" {
		t.Fatalf("first valid panel keeps its id: got %q", got[0].ID)
	}

	// 上限：一屏三十个面板就不再是看板了
	many := make([]model.DashboardPanel, 0, MaxPanels+5)
	for i := 0; i < MaxPanels+5; i++ {
		many = append(many, model.DashboardPanel{ID: string(rune('a' + i%26)), Dataset: "ds"})
	}
	if got := normalizePanels(many); len(got) != MaxPanels {
		t.Fatalf("panels should be capped at %d: got %d", MaxPanels, len(got))
	}
}

func TestNormalizeDashboardKeyAndTitle(t *testing.T) {
	if _, err := normalizeDashboardKey("Collect-Overview"); !errors.Is(err, ErrDashboardInvalid) {
		t.Fatalf("uppercase key must be rejected: %v", err)
	}
	if _, err := normalizeDashboardKey("-abc"); !errors.Is(err, ErrDashboardInvalid) {
		t.Fatalf("leading dash must be rejected: %v", err)
	}
	if k, err := normalizeDashboardKey(" qc-daily2 "); err != nil || k != "qc-daily2" {
		t.Fatalf("valid key should be trimmed: %q %v", k, err)
	}
}
