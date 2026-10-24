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
		{"登录态无租户时，受限数据源不可见", ACL{Tenants: []string{"a"}}, nil, false},
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
