package middleware

import (
	"net/http"
	"strings"

	"dataset_service/internal/auth"

	"github.com/gin-gonic/gin"
)

// 自报头：仅 off 模式生效。dev / jwt 模式下一律忽略，
// 否则任何人改个请求头就能换身份，鉴权就形同虚设。
const (
	HeaderUser         = "X-User"
	HeaderTenants      = "X-Tenants"
	HeaderVisibleUsers = "X-Visible-Users"
)

// 这两个端点必须在登录之前就能访问：mode 告诉前端「要不要登录、怎么登录」，
// login 是拿 token 的地方。把它们放进鉴权范围会形成先有鸡还是先有蛋的死循环。
var authExempt = map[string]bool{
	"/api/v1/auth/mode":  true,
	"/api/v1/auth/login": true,
}

// Auth 认证中间件，替换原先的 Operator / Tenants / VisibleUsers 三个自报中间件。
//
//   - off：不校验，行为与改造前完全一致，存量部署升级后不会被拦。
//   - dev / jwt：只认 Authorization: Bearer <jwt>，身份来自 token，自报头忽略。
//
// 非 /api/ 路径（前端静态资源）一律放行：页面本身要能在未登录时打开，
// 否则登录页都渲染不出来。真正的拦截发生在 API 上，由前端收到 401 后跳登录。
func Auth(v *auth.Verifier) gin.HandlerFunc {
	return func(c *gin.Context) {
		p := c.Request.URL.Path
		if !strings.HasPrefix(p, "/api/") || authExempt[p] {
			passThrough(c, v, nil)
			return
		}
		if v.Mode() == auth.ModeOff {
			op := strings.TrimSpace(c.GetHeader(HeaderUser))
			if op == "" {
				op = "system"
			}
			if len(op) > 64 {
				op = op[:64]
			}
			passThrough(c, v, &auth.Identity{
				User:         op,
				Tenants:      ParseMultiValue(c.GetHeader(HeaderTenants)),
				VisibleUsers: ParseMultiValue(c.GetHeader(HeaderVisibleUsers)),
			})
			return
		}

		raw := bearerToken(c)
		if raw == "" {
			unauthorized(c, "缺少登录凭证，请重新登录")
			return
		}
		id, err := v.Verify(raw)
		if err != nil {
			// 具体原因不回给客户端：token 为什么错，是企业 IdP 该告诉他的事，
			// 这里只需要他知道「得重新登录」。细节留在服务端日志里。
			unauthorized(c, "登录凭证无效或已过期，请重新登录")
			return
		}
		passThrough(c, v, id)
	}
}

// passThrough 把身份写进 context，同时写回老的三个键，
// 让下面所有依赖 operator / tenants / visible_users 的代码一行都不用改。
func passThrough(c *gin.Context, v *auth.Verifier, id *auth.Identity) {
	if id == nil {
		id = &auth.Identity{}
	}
	auth.SetContext(c, *id)
	c.Set("operator", id.User)
	c.Set(TenantCtxKey, id.Tenants)
	c.Set(VisibleUsersCtxKey, id.VisibleUsers)
	_ = v
	c.Next()
}

// RequireEditor 拦截改配置的写接口。
// off 模式直接放行——不鉴权的时候谈角色没有意义，也会一升级就把现有部署拦死。
func RequireEditor(v *auth.Verifier) gin.HandlerFunc {
	return func(c *gin.Context) {
		if v.Mode() != auth.ModeOff && !v.IsEditor(auth.FromContext(c)) {
			writeAuthError(c, http.StatusForbidden, "需要 editor 角色才能修改配置，当前身份只读")
			return
		}
		c.Next()
	}
}

func bearerToken(c *gin.Context) string {
	h := strings.TrimSpace(c.GetHeader("Authorization"))
	if len(h) > 7 && strings.EqualFold(h[:7], "bearer ") {
		return strings.TrimSpace(h[7:])
	}
	return ""
}

func unauthorized(c *gin.Context, msg string) {
	writeAuthError(c, http.StatusUnauthorized, msg)
}

func writeAuthError(c *gin.Context, status int, msg string) {
	c.Header("WWW-Authenticate", "Bearer")
	c.AbortWithStatusJSON(status, gin.H{
		"code":       status,
		"message":    msg,
		"request_id": c.GetString("request_id"),
	})
}
