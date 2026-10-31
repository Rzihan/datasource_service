package handler

import (
	"net/http"

	"dataset_service/internal/auth"

	"github.com/gin-gonic/gin"
)

// AuthHandler 暴露三个端点：mode、login、me。
// 刻意不做注册 / 找回密码 / 改密 / 刷新令牌——企业已有 IdP，重复建设永远追不上。
type AuthHandler struct {
	v      *auth.Verifier
	ssoURL string
}

func NewAuthHandler(v *auth.Verifier, ssoURL string) *AuthHandler {
	return &AuthHandler{v: v, ssoURL: ssoURL}
}

// Mode 是前端启动后第一个请求：告诉它「要不要登录、登录页长什么样」。
// 不鉴权，因为问这个问题的人本来就还没登录。
func (h *AuthHandler) Mode(c *gin.Context) {
	mode := h.v.Mode()
	kind := ""
	switch mode {
	case auth.ModeDev:
		kind = "dev"
	case auth.ModeJWT:
		kind = "sso"
	}
	OK(c, gin.H{
		"mode":       mode,
		"need_login": mode != auth.ModeOff,
		"login_kind": kind,
		"sso_url":    h.ssoURL,
		// dev 模式下列在登录页上让人点一下即可，jwt 模式为空数组
		"identities": h.v.DevIdentities(),
	})
}

// Login 仅在 dev 模式注册：选一个预置身份，换一个本地签发的 token。
// 生产模式下这个路由根本不存在（不是运行时报错，是不注册）。
func (h *AuthHandler) Login(c *gin.Context) {
	if h.v.Mode() != auth.ModeDev {
		Fail(c, http.StatusNotFound, http.StatusNotFound, "登录接口仅在 dev 模式开放")
		return
	}
	var req struct {
		User string `json:"user"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		BadRequest(c, "请求体应为 {\"user\": \"...\"}")
		return
	}
	id, ok := h.v.FindDevIdentity(req.User)
	if !ok {
		Fail(c, http.StatusNotFound, http.StatusNotFound, "预置身份里没有这个用户："+req.User)
		return
	}
	token, err := h.v.Issue(*id)
	if err != nil {
		Fail(c, http.StatusInternalServerError, http.StatusInternalServerError, "签发失败："+err.Error())
		return
	}
	OK(c, gin.H{
		"token":      token,
		"identity":   id,
		"expires_in": int(h.v.Config().TTL.Seconds()),
	})
}

// Me 返回当前身份，供前端顶栏展示。off 模式下返回自报的那个身份。
func (h *AuthHandler) Me(c *gin.Context) {
	id := auth.FromContext(c)
	OK(c, gin.H{
		"mode":     h.v.Mode(),
		"identity": id,
		"editor":   h.v.IsEditor(id),
	})
}
