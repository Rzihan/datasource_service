package middleware

import (
	"crypto/rand"
	"encoding/hex"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// RequestID 为每次请求生成或透传 request_id，便于串联日志与排查问题。
func RequestID(header string) gin.HandlerFunc {
	if header == "" {
		header = "X-Request-Id"
	}
	return func(c *gin.Context) {
		id := strings.TrimSpace(c.GetHeader(header))
		if id == "" {
			id = newID()
		}
		c.Set("request_id", id)
		c.Header(header, id)
		c.Next()
	}
}

// Operator 解析操作人。系统不接鉴权，操作人来自 X-User 请求头，
// 缺失时回落为 system，写入 created_by / updated_by。
func Operator(header string) gin.HandlerFunc {
	if header == "" {
		header = "X-User"
	}
	return func(c *gin.Context) {
		op := strings.TrimSpace(c.GetHeader(header))
		if op == "" {
			op = "system"
		}
		if len(op) > 64 {
			op = op[:64]
		}
		c.Set("operator", op)
		c.Next()
	}
}

// 登录态在 gin context 里的键。
const (
	TenantCtxKey = "tenants"
	// VisibleUsersCtxKey 是当前用户「能看到哪些用户的数据」的列表，用于行级权限过滤。
	// 注意它与 operator（X-User，我是谁）不是一回事，这里是「我能看到谁」。
	VisibleUsersCtxKey = "visible_users"
)

// Tenants 解析当前登录态所属的租户，来自 X-Tenants 请求头（逗号分隔，支持多租户）。
//
// 与 Operator 同一套思路：系统不接鉴权，租户由调用方自报，
// 只用于判断数据源对当前登录态是否可见，不作为安全边界。
func Tenants(header string) gin.HandlerFunc {
	if header == "" {
		header = "X-Tenants"
	}
	return func(c *gin.Context) {
		c.Set(TenantCtxKey, ParseMultiValue(c.GetHeader(header)))
		c.Next()
	}
}

// VisibleUsers 解析当前登录态可见的用户列表，来自 X-Visible-Users 请求头（逗号分隔）。
func VisibleUsers(header string) gin.HandlerFunc {
	if header == "" {
		header = "X-Visible-Users"
	}
	return func(c *gin.Context) {
		c.Set(VisibleUsersCtxKey, ParseMultiValue(c.GetHeader(header)))
		c.Next()
	}
}

// CurrentVisibleUsers 从 gin context 取可见用户列表。
func CurrentVisibleUsers(c *gin.Context) []string {
	if v, ok := c.Get(VisibleUsersCtxKey); ok {
		if list, ok := v.([]string); ok {
			return list
		}
	}
	return []string{}
}

// ParseMultiValue 解析逗号分隔的取值串：去空白、丢弃空串、去重，保持原有顺序。
func ParseMultiValue(raw string) []string {
	if strings.TrimSpace(raw) == "" {
		return []string{}
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	seen := make(map[string]struct{}, len(parts))
	for _, p := range parts {
		t := strings.TrimSpace(p)
		if t == "" {
			continue
		}
		if len(t) > 64 {
			t = t[:64]
		}
		if _, ok := seen[t]; ok {
			continue
		}
		seen[t] = struct{}{}
		out = append(out, t)
	}
	return out
}

// CurrentTenants 从 gin context 取登录态租户。中间件没挂时返回空切片（等价于无租户）。
func CurrentTenants(c *gin.Context) []string {
	if v, ok := c.Get(TenantCtxKey); ok {
		if list, ok := v.([]string); ok {
			return list
		}
	}
	return []string{}
}

// Logger 结构化访问日志。
func Logger() gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		c.Next()
		slog.Info("http request",
			"request_id", c.GetString("request_id"),
			"method", c.Request.Method,
			"path", c.Request.URL.Path,
			"status", c.Writer.Status(),
			"latency_ms", time.Since(start).Milliseconds(),
			"client_ip", c.ClientIP(),
			"operator", c.GetString("operator"),
			"tenants", strings.Join(CurrentTenants(c), ","),
			"errors", c.Errors.String(),
		)
	}
}

// CORS 仅用于本地前后端分离开发（vite dev server 端口不同）。部署态是同源，不会命中。
func CORS() gin.HandlerFunc {
	return func(c *gin.Context) {
		origin := c.GetHeader("Origin")
		if origin != "" {
			c.Header("Access-Control-Allow-Origin", origin)
			c.Header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS")
			c.Header("Access-Control-Allow-Headers", "Content-Type,X-User,X-Tenants,X-Visible-Users,X-Request-Id")
			c.Header("Access-Control-Max-Age", "86400")
		}
		if c.Request.Method == http.MethodOptions {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
		c.Next()
	}
}

func newID() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return strconvItoa(time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}

func strconvItoa(n int64) string {
	return hex.EncodeToString([]byte{byte(n >> 56), byte(n >> 48), byte(n >> 40), byte(n >> 32),
		byte(n >> 24), byte(n >> 16), byte(n >> 8), byte(n)})
}
