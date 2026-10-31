// Package auth 只做一件事：把请求里那串 JWT 翻译成「这个平台的身份」。
//
// 这个平台的侧重点是数据分析，不是身份管理，所以这里刻意不建用户表、不做注册与找回密码、
// 不存会话：真实环境由企业 IdP 签发 JWT，本服务只验签，然后把 claims 映射成身份。
//
// 「能看哪些数据」继续由数据集上已有的 acl（租户 / 列 / 行）决定，这里不另造一套权限体系。
// 角色因此也只有两个：viewer 看数，editor 改配置。
package auth

import (
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"log/slog"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
)

// 三种运行模式。默认 off，与改造前行为完全一致，存量部署升级后不会被拦住。
const (
	ModeOff = "off" // 不鉴权：身份由 X-User / X-Tenants / X-Visible-Users 自报
	ModeDev = "dev" // 本地与演示：预置几个身份，登录即签发一个本地 JWT，不需要 IdP
	ModeJWT = "jwt" // 生产：只验签不签发，token 由企业 IdP 下发
)

// Identity 是一次请求的身份。字段只有四个：谁在查、属于哪些租户、能代看谁、有什么角色。
type Identity struct {
	User         string   `json:"user"`
	Tenants      []string `json:"tenants"`
	VisibleUsers []string `json:"visible_users"`
	Roles        []string `json:"roles"`
}

// Config 鉴权配置，全部由环境变量驱动。
type Config struct {
	Mode         string // off / dev / jwt
	Secret       string // HS256 验签与 dev 签发用的共享密钥
	PublicKeyPEM string // RS256 公钥，配置了就按 RS256 验签；与 Secret 二选一
	Issuer       string // 期望的 iss，留空不校验
	Audience     string // 期望的 aud，留空不校验
	TTL          time.Duration
	// claims 映射：不同企业 IdP 的字段名不一样，全都可配，默认取下面这组常见值
	ClaimUser         string
	ClaimTenants      string
	ClaimVisibleUsers string
	ClaimRoles        string
	EditorRoles       []string // claims 里哪些角色算 editor，默认 editor/admin
	DevIdentities     []Identity
	SSOURL            string // jwt 模式下前端登录页跳转用的企业登录地址
}

// Verifier 验签器。dev 模式额外承担签发职责。
type Verifier struct {
	cfg    Config
	pubKey *rsa.PublicKey
}

// New 构造验签器并做一次自检：配置明显不对时宁可启动失败，也不要在生产里静默放行。
func New(cfg Config) (*Verifier, error) {
	v := &Verifier{cfg: cfg}
	if cfg.Mode == ModeOff {
		return v, nil
	}
	if cfg.Mode != ModeDev && cfg.Mode != ModeJWT {
		return nil, errors.New("AUTH_MODE must be one of off/dev/jwt")
	}
	if cfg.PublicKeyPEM != "" {
		key, err := parseRSAPublicKey(cfg.PublicKeyPEM)
		if err != nil {
			return nil, err
		}
		v.pubKey = key
	} else if cfg.Secret == "" {
		if cfg.Mode == ModeDev {
			// dev 模式没有 IdP，给一个固定兜底密钥，让本地重启后旧 token 仍然可用。
			cfg.Secret = "dev-only-not-a-secret"
			v.cfg.Secret = cfg.Secret
			slog.Warn("auth: AUTH_JWT_SECRET is empty, using built-in dev secret; never do this in production")
		} else {
			return nil, errors.New("AUTH_MODE=jwt requires AUTH_JWT_SECRET or AUTH_JWT_PUBLIC_KEY")
		}
	}
	if cfg.Mode == ModeDev && len(cfg.DevIdentities) == 0 {
		cfg.DevIdentities = defaultDevIdentities()
		v.cfg.DevIdentities = cfg.DevIdentities
	}
	if cfg.TTL <= 0 {
		v.cfg.TTL = 8 * time.Hour
	}
	// claims 名与角色名也要兜底：直接构造 Config（测试、嵌入调用）时容易漏，
	// 漏了的表现是「登录成功但身份全空」，比启动失败难查得多。
	if cfg.ClaimUser == "" {
		v.cfg.ClaimUser = "sub"
	}
	if cfg.ClaimTenants == "" {
		v.cfg.ClaimTenants = "tenants"
	}
	if cfg.ClaimVisibleUsers == "" {
		v.cfg.ClaimVisibleUsers = "visible_users"
	}
	if cfg.ClaimRoles == "" {
		v.cfg.ClaimRoles = "roles"
	}
	if len(v.cfg.EditorRoles) == 0 {
		v.cfg.EditorRoles = []string{"editor", "admin"}
	}
	return v, nil
}

func (v *Verifier) Mode() string              { return v.cfg.Mode }
func (v *Verifier) Config() Config            { return v.cfg }
func (v *Verifier) DevIdentities() []Identity { return v.cfg.DevIdentities }

// IsEditor 判断身份能否改配置（数据集 / 字段名称 / 大盘 / 迁移状态）。
// off 模式没有角色概念，一律放行，保持改造前行为。
func (v *Verifier) IsEditor(id Identity) bool {
	if v.cfg.Mode == ModeOff {
		return true
	}
	for _, r := range id.Roles {
		for _, e := range v.cfg.EditorRoles {
			if strings.EqualFold(strings.TrimSpace(r), strings.TrimSpace(e)) {
				return true
			}
		}
	}
	return false
}

// Verify 校验 token 并映射成身份。
func (v *Verifier) Verify(raw string) (*Identity, error) {
	if v.cfg.Mode == ModeOff {
		return nil, errors.New("verification is disabled in off mode")
	}
	opts := []jwt.ParserOption{jwt.WithValidMethods([]string{"HS256", "RS256"})}
	if v.cfg.Issuer != "" {
		opts = append(opts, jwt.WithIssuer(v.cfg.Issuer))
	}
	if v.cfg.Audience != "" {
		opts = append(opts, jwt.WithAudience(v.cfg.Audience))
	}
	claims := jwt.MapClaims{}
	if _, err := jwt.ParseWithClaims(raw, claims, v.keyFunc, opts...); err != nil {
		return nil, err
	}
	id := &Identity{
		User:         claimString(claims, v.cfg.ClaimUser),
		Tenants:      claimStrings(claims, v.cfg.ClaimTenants),
		VisibleUsers: claimStrings(claims, v.cfg.ClaimVisibleUsers),
		Roles:        claimStrings(claims, v.cfg.ClaimRoles),
	}
	if id.User == "" {
		// 没有主体就无法审计，也无法作为行级过滤的取值，宁可拒绝。
		return nil, errors.New("token has no usable subject claim")
	}
	return id, nil
}

func (v *Verifier) keyFunc(t *jwt.Token) (interface{}, error) {
	if v.pubKey != nil {
		if _, ok := t.Method.(*jwt.SigningMethodRSA); !ok {
			return nil, errors.New("unexpected signing method, want RS256")
		}
		return v.pubKey, nil
	}
	if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
		return nil, errors.New("unexpected signing method, want HS256")
	}
	return []byte(v.cfg.Secret), nil
}

// Issue 签发 token。只有 dev 模式允许——生产环境的 token 必须由企业 IdP 下发，
// 本服务一旦能自己签，就等于把身份体系的根交出去了。
func (v *Verifier) Issue(id Identity) (string, error) {
	if v.cfg.Mode != ModeDev {
		return "", errors.New("issuing token is only allowed in dev mode")
	}
	now := time.Now()
	claims := jwt.MapClaims{
		"iat":            now.Unix(),
		"exp":            now.Add(v.cfg.TTL).Unix(),
		v.cfg.ClaimUser:  id.User,
		v.cfg.ClaimRoles: id.Roles,
	}
	if len(id.Tenants) > 0 {
		claims[v.cfg.ClaimTenants] = id.Tenants
	}
	if len(id.VisibleUsers) > 0 {
		claims[v.cfg.ClaimVisibleUsers] = id.VisibleUsers
	}
	if v.cfg.Issuer != "" {
		claims["iss"] = v.cfg.Issuer
	}
	if v.cfg.Audience != "" {
		claims["aud"] = v.cfg.Audience
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(v.cfg.Secret))
}

// FindDevIdentity 在预置身份里按用户名查找，供 dev 登录用。
func (v *Verifier) FindDevIdentity(user string) (*Identity, bool) {
	for _, id := range v.cfg.DevIdentities {
		if strings.EqualFold(id.User, strings.TrimSpace(user)) {
			found := id
			return &found, true
		}
	}
	return nil, false
}

func parseRSAPublicKey(s string) (*rsa.PublicKey, error) {
	block, _ := pem.Decode([]byte(strings.ReplaceAll(s, "\\n", "\n")))
	if block == nil {
		return nil, errors.New("AUTH_JWT_PUBLIC_KEY is not valid PEM")
	}
	if key, err := x509.ParsePKIXPublicKey(block.Bytes); err == nil {
		if pub, ok := key.(*rsa.PublicKey); ok {
			return pub, nil
		}
		return nil, errors.New("public key is not RSA")
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return nil, errors.New("public key is neither PKIX nor certificate")
	}
	pub, ok := cert.PublicKey.(*rsa.PublicKey)
	if !ok {
		return nil, errors.New("certificate public key is not RSA")
	}
	return pub, nil
}

// claimStrings 读取可能是字符串、字符串数组、或逗号分隔字符串的 claim。
// 企业的 IdP 这三种都见过，与其要求对方改模板，不如都认。
func claimStrings(claims jwt.MapClaims, key string) []string {
	if key == "" {
		return nil
	}
	raw, ok := claims[key]
	if !ok {
		return nil
	}
	switch v := raw.(type) {
	case string:
		return splitList(v)
	case []string:
		return compact(v)
	case []interface{}:
		out := make([]string, 0, len(v))
		for _, item := range v {
			if s, ok := item.(string); ok {
				if s = strings.TrimSpace(s); s != "" {
					out = append(out, s)
				}
			}
		}
		return out
	}
	return nil
}

func claimString(claims jwt.MapClaims, key string) string {
	if key == "" {
		return ""
	}
	if v, ok := claims[key].(string); ok {
		return strings.TrimSpace(v)
	}
	if list := claimStrings(claims, key); len(list) > 0 {
		return list[0]
	}
	return ""
}

func splitList(s string) []string {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func compact(in []string) []string {
	out := make([]string, 0, len(in))
	for _, s := range in {
		if s = strings.TrimSpace(s); s != "" {
			out = append(out, s)
		}
	}
	return out
}

func defaultDevIdentities() []Identity {
	return []Identity{
		{User: "alice", Tenants: []string{"采集组", "质检组"}, Roles: []string{"editor"}},
		{User: "bob", Tenants: []string{"采集组"}, Roles: []string{"viewer"}},
		{User: "carol", Tenants: nil, Roles: []string{"viewer"}},
	}
}

// --- gin context 上的身份 ---

// CtxKey 是身份在 gin context 里的键。
const CtxKey = "auth_identity"

// SetContext 把身份放进 gin context。
func SetContext(c *gin.Context, id Identity) { c.Set(CtxKey, id) }

// FromContext 取当前身份。没挂中间件时返回零值，调用方按「没有身份」处理即可。
func FromContext(c *gin.Context) Identity {
	if v, ok := c.Get(CtxKey); ok {
		if id, ok := v.(Identity); ok {
			return id
		}
	}
	return Identity{}
}
