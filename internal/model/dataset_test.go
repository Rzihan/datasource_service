package model

import "testing"

func TestACLAllows(t *testing.T) {
	cases := []struct {
		name    string
		acl     ACL
		tenants []string
		want    bool
	}{
		{"空白名单=公开，登录态无租户也能看", ACL{}, nil, true},
		{"空白名单=公开，任何租户都能看", ACL{}, []string{"anyone"}, true},
		{"白名单为空切片同样表示公开", ACL{Tenants: []string{}}, []string{"anyone"}, true},
		{"有交集即可见", ACL{Tenants: []string{"b", "a"}}, []string{"a"}, true},
		{"多租户登录态命中其中一个即可", ACL{Tenants: []string{"a"}}, []string{"x", "a"}, true},
		{"无交集不可见", ACL{Tenants: []string{"a", "b"}}, []string{"c"}, false},
		{"登录态无租户时，受限数据集不可见", ACL{Tenants: []string{"a"}}, nil, false},
		{"有白名单但登录态为空切片不可见", ACL{Tenants: []string{"a"}}, []string{}, false},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := c.acl.Allows(c.tenants); got != c.want {
				t.Fatalf("ACL(%+v).Allows(%v) = %v, want %v", c.acl, c.tenants, got, c.want)
			}
		})
	}
}

func TestACLAllowsColumn(t *testing.T) {
	acl := ACL{
		Tenants:    []string{"t1", "t2"},
		ColTenants: map[string][]string{"cost": {"t1"}, "clicks": {"t9"}},
	}

	cases := []struct {
		name    string
		col     string
		tenants []string
		want    bool
	}{
		{"没配的列默认可见", "date", nil, true},
		{"没配的列对任何租户可见", "date", []string{"anyone"}, true},
		{"配了且有交集", "cost", []string{"t1"}, true},
		{"多租户登录态命中其中一个", "cost", []string{"x", "t1"}, true},
		{"配了但无交集", "cost", []string{"t2"}, false},
		{"登录态无租户时受限列不可见", "cost", nil, false},
		{"另一个受限列无交集", "clicks", []string{"t1"}, false},
		{"完全没配 col_tenants 时所有列可见", "cost", nil, true},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			a := acl
			if c.name == "完全没配 col_tenants 时所有列可见" {
				a = ACL{Tenants: []string{"t1"}}
			}
			if got := a.AllowsColumn(c.col, c.tenants); got != c.want {
				t.Fatalf("AllowsColumn(%q, %v) = %v, want %v", c.col, c.tenants, got, c.want)
			}
		})
	}
}

// 配了空列表等价于「不限制」，与 tenants 的语义保持一致。
func TestACLAllowsColumnEmptyList(t *testing.T) {
	acl := ACL{ColTenants: map[string][]string{"cost": {}}}
	if !acl.AllowsColumn("cost", nil) {
		t.Fatal("empty whitelist should mean no restriction")
	}
}
