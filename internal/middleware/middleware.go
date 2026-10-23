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
			c.Header("Access-Control-Allow-Headers", "Content-Type,X-User,X-Request-Id")
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
