package auth

import (
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func devVerifier(t *testing.T) *Verifier {
	t.Helper()
	v, err := New(Config{Mode: ModeDev, Secret: "s3cret", TTL: time.Hour})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return v
}

func TestIssueThenVerify(t *testing.T) {
	v := devVerifier(t)
	id := Identity{User: "alice", Tenants: []string{"采集组"}, VisibleUsers: []string{"bob"}, Roles: []string{"editor"}}
	tok, err := v.Issue(id)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	got, err := v.Verify(tok)
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if got.User != "alice" {
		t.Fatalf("user = %q, want alice", got.User)
	}
	if len(got.Tenants) != 1 || got.Tenants[0] != "采集组" {
		t.Fatalf("tenants = %v", got.Tenants)
	}
	if len(got.VisibleUsers) != 1 || got.VisibleUsers[0] != "bob" {
		t.Fatalf("visible_users = %v", got.VisibleUsers)
	}
	if !v.IsEditor(*got) {
		t.Fatal("editor role not recognized")
	}
}

func TestVerifyRejects(t *testing.T) {
	v := devVerifier(t)
	tok, _ := v.Issue(Identity{User: "alice", Roles: []string{"editor"}})

	// 换了密钥签的 token 必须验不过：这是整套鉴权的底线
	other, err := New(Config{Mode: ModeDev, Secret: "another", TTL: time.Hour})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if _, err := other.Verify(tok); err == nil {
		t.Fatal("token signed with another secret must be rejected")
	}

	// 过期
	expired := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"sub": "alice", "exp": time.Now().Add(-time.Minute).Unix(),
	})
	s, err := expired.SignedString([]byte("s3cret"))
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	if _, err := v.Verify(s); err == nil {
		t.Fatal("expired token must be rejected")
	}

	// 没有主体：无法审计也无法做行级过滤，宁可拒绝
	anon := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{"exp": time.Now().Add(time.Hour).Unix()})
	s, _ = anon.SignedString([]byte("s3cret"))
	if _, err := v.Verify(s); err == nil {
		t.Fatal("token without subject must be rejected")
	}

	// 算法降级：拿公钥当 HMAC 密钥签的经典攻击，RS256 校验器必须拒绝 HS256
	v.pubKey = nil
	if _, err := v.Verify(tok); err != nil {
		t.Fatalf("hs256 should still work: %v", err)
	}
}

func TestIssuerAudience(t *testing.T) {
	v, err := New(Config{Mode: ModeDev, Secret: "s3cret", TTL: time.Hour, Issuer: "corp-idp", Audience: "ds"})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	tok, err := v.Issue(Identity{User: "alice"})
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	if _, err := v.Verify(tok); err != nil {
		t.Fatalf("own token should carry issuer/audience: %v", err)
	}
	// 别处签发的 token 缺 iss，必须拒绝
	wrong := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"sub": "alice", "iss": "someone-else", "exp": time.Now().Add(time.Hour).Unix(),
	})
	s, _ := wrong.SignedString([]byte("s3cret"))
	if _, err := v.Verify(s); err == nil {
		t.Fatal("token from another issuer must be rejected")
	}
}

// 不同企业的 IdP，租户 claim 可能是数组、逗号分隔字符串、或者单个字符串。
// 与其要求对方改模板，不如三种都认。
func TestClaimShapes(t *testing.T) {
	v, err := New(Config{Mode: ModeDev, Secret: "s3cret", TTL: time.Hour})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	cases := []struct {
		name  string
		claim interface{}
		want  []string
	}{
		{"array", []interface{}{"t1", "t2"}, []string{"t1", "t2"}},
		{"csv", "t1,t2", []string{"t1", "t2"}},
		{"single", "t1", []string{"t1"}},
		{"empty", "", nil},
		{"nil", nil, nil},
	}
	for _, c := range cases {
		claims := jwt.MapClaims{"sub": "alice", "exp": time.Now().Add(time.Hour).Unix()}
		if c.claim != nil {
			claims["tenants"] = c.claim
		}
		tok, _ := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte("s3cret"))
		got, err := v.Verify(tok)
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if len(got.Tenants) != len(c.want) {
			t.Fatalf("%s: tenants = %v, want %v", c.name, got.Tenants, c.want)
		}
		for i := range c.want {
			if got.Tenants[i] != c.want[i] {
				t.Fatalf("%s: tenants = %v, want %v", c.name, got.Tenants, c.want)
			}
		}
	}
}

func TestOffModeIssuesNothing(t *testing.T) {
	v, err := New(Config{Mode: ModeOff})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if _, err := v.Issue(Identity{User: "alice"}); err == nil {
		t.Fatal("off mode must not issue tokens")
	}
	if _, err := v.Verify("anything"); err == nil {
		t.Fatal("off mode must not verify tokens")
	}
	// 不鉴权时人人可改：升级不能把现有部署拦死
	if !v.IsEditor(Identity{}) {
		t.Fatal("off mode should treat everyone as editor")
	}
}

func TestJWTModeRequiresKey(t *testing.T) {
	if _, err := New(Config{Mode: ModeJWT}); err == nil {
		t.Fatal("jwt mode without secret must fail fast")
	}
	if _, err := New(Config{Mode: "bogus"}); err == nil {
		t.Fatal("unknown mode must fail fast")
	}
}

func TestViewerIsNotEditor(t *testing.T) {
	v := devVerifier(t)
	if v.IsEditor(Identity{User: "bob", Roles: []string{"viewer"}}) {
		t.Fatal("viewer must not be editor")
	}
	if v.IsEditor(Identity{User: "bob"}) {
		t.Fatal("no role must not be editor")
	}
	// 企业里的角色名不统一，大小写与空格都要能容忍
	if !v.IsEditor(Identity{User: "x", Roles: []string{" Admin "}}) {
		t.Fatal("admin should match case-insensitively")
	}
}

func TestFindDevIdentity(t *testing.T) {
	v := devVerifier(t)
	if _, ok := v.FindDevIdentity("alice"); !ok {
		t.Fatal("built-in identity alice should exist")
	}
	if _, ok := v.FindDevIdentity("nobody"); ok {
		t.Fatal("unknown user must not resolve")
	}
}
