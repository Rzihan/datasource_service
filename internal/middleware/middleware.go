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

// 登录态在 gin context 里的键。
const (
	TenantCtxKey = "tenants"
	// VisibleUsersCtxKey 是当前用户「能看到哪些用户的数据」的列表，用于行级权限过滤。
	// 注意它与 operator（X-User，我是谁）不是一回事，这里是「我能看到谁」。
	VisibleUsersCtxKey = "visible_users"
)

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
