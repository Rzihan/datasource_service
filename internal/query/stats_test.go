package query

import (
	"testing"
	"time"
)

func TestPickDateFieldPrefersDateLikeKeys(t *testing.T) {
	got := pickDateField(map[string]string{"scene": "scene", "stat_date": "d", "team": "team"})
	if got != "stat_date" {
		t.Fatalf("want stat_date, got %q", got)
	}
}

// pickDateField 必须稳定：扫出来的 min/max 会进缓存，
// 每次挑到不同列的话，覆盖区间会在两次刷新之间跳。
func TestPickDateFieldIsStable(t *testing.T) {
	dims := map[string]string{"dt": "d", "day_id": "d2", "zzz": "z"}
	first := pickDateField(dims)
	for i := 0; i < 20; i++ {
		if pickDateField(dims) != first {
			t.Fatalf("unstable pick: %q vs %q", first, pickDateField(dims))
		}
	}
}

func TestPickDateFieldNoDate(t *testing.T) {
	if got := pickDateField(map[string]string{"scene": "s", "team": "t"}); got != "" {
		t.Fatalf("want empty, got %q", got)
	}
}

func TestDaysBetweenInclusive(t *testing.T) {
	if got := daysBetween("2025-10-01", "2025-10-07"); got != 7 {
		t.Fatalf("want 7, got %d", got)
	}
	if got := daysBetween("2025-10-01", "2025-10-01"); got != 1 {
		t.Fatalf("same day should cover 1 day, got %d", got)
	}
	// 数据里有未来日期时 lag 为负：卡片要能说「数据里出现了未来日期」
	if got := daysBetween("2025-10-07", "2025-10-01"); got != -5 {
		t.Fatalf("want -5, got %d", got)
	}
	if got := daysBetween("", "2025-10-01"); got != 0 {
		t.Fatalf("want 0 for empty input, got %d", got)
	}
}

func TestToInt64(t *testing.T) {
	cases := []any{int64(42), int32(42), uint64(42), 42, float64(42), nil}
	for _, c := range cases {
		if got := toInt64(c); got != 0 && c != nil && got != 42 {
			t.Fatalf("toInt64(%#v) = %d", c, got)
		}
	}
	if got := toInt64(nil); got != 0 {
		t.Fatalf("nil should be 0, got %d", got)
	}
}

func TestDateString(t *testing.T) {
	d := time.Date(2025, 10, 24, 0, 0, 0, 0, time.UTC)
	if got := dateString(d); got != "2025-10-24" {
		t.Fatalf("want 2025-10-24, got %q", got)
	}
	if got := dateString("2025-10-24 00:00:00"); got != "2025-10-24" {
		t.Fatalf("want 2025-10-24, got %q", got)
	}
	if got := dateString(nil); got != "" {
		t.Fatalf("nil should be empty, got %q", got)
	}
}

// 缓存：同一 key 命中缓存后 Cached=true，且两个调用方拿到的是不同的副本，
// 否则外面的 Cached 标记会互相污染。
func TestStatsCacheHitAndExpiry(t *testing.T) {
	c := newStatsCache(10 * time.Millisecond)
	s := &DatasetStats{DatasetKey: "ds", RowCount: 7}
	c.set("k", s)
	got, ok := c.get("k")
	if !ok || got.RowCount != 7 {
		t.Fatalf("cache miss right after set")
	}
	if got == s {
		t.Fatal("cache should hand out a copy")
	}
	time.Sleep(20 * time.Millisecond)
	if _, ok := c.get("k"); ok {
		t.Fatal("entry should be expired")
	}
}
