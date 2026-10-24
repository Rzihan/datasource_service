package middleware

import "testing"

func TestParseTenants(t *testing.T) {
	cases := []struct {
		raw  string
		want []string
	}{
		{"", []string{}},
		{"   ", []string{}},
		{"t1", []string{"t1"}},
		{"t1,t2", []string{"t1", "t2"}},
		{" t1 , t2 ", []string{"t1", "t2"}},   // 去空白
		{"t1,,t2,", []string{"t1", "t2"}},     // 丢弃空串
		{"t1,t1,t2", []string{"t1", "t2"}},    // 去重
		{"b,a,b", []string{"b", "a"}},         // 去重后保持原有顺序
		{"t1;t2", []string{"t1;t2"}},          // 只按逗号分隔，分号不算分隔符
	}

	for _, c := range cases {
		got := ParseTenants(c.raw)
		if len(got) != len(c.want) {
			t.Fatalf("ParseTenants(%q) = %v, want %v", c.raw, got, c.want)
		}
		for i := range got {
			if got[i] != c.want[i] {
				t.Fatalf("ParseTenants(%q) = %v, want %v", c.raw, got, c.want)
			}
		}
	}
}

func TestParseTenantsTruncates(t *testing.T) {
	long := make([]byte, 100)
	for i := range long {
		long[i] = 'x'
	}
	got := ParseTenants(string(long))
	if len(got) != 1 || len(got[0]) != 64 {
		t.Fatalf("expected single tenant truncated to 64 bytes, got %d bytes", len(got[0]))
	}
}
