package query

import (
	"errors"
	"net/http"

	"dataset_service/internal/handler"
	"dataset_service/internal/middleware"
	"dataset_service/internal/repo"

	"github.com/gin-gonic/gin"
)

// Handler 查询相关的 HTTP 入口。
type Handler struct {
	svc *Service
}

// NewHandler 构造 handler。
func NewHandler(svc *Service) *Handler {
	return &Handler{svc: svc}
}

// Execute 执行查询。请求体是「查询意图」，不是 SQL。
func (h *Handler) Execute(c *gin.Context) {
	var req ExecuteRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		handler.BadRequest(c, "请求体不是合法 JSON")
		return
	}
	res, err := h.svc.Execute(c.Request.Context(), &req, operatorFromContext(c), tenantsFromContext(c), usersFromContext(c))
	if err != nil {
		writeQueryError(c, err)
		return
	}
	handler.OK(c, res)
}

// Datasets 查询页可选的数据集：已按当前登录态的租户白名单过滤。
func (h *Handler) Datasets(c *gin.Context) {
	items, err := h.svc.VisibleDatasets(c.Request.Context(), tenantsFromContext(c))
	if err != nil {
		handler.Fail(c, http.StatusInternalServerError, http.StatusInternalServerError, err.Error())
		return
	}
	handler.OK(c, gin.H{"items": items})
}

// DryRun 配置自检：拿真实 ClickHouse 跑一遍待保存的配置。
// 失败也算 200——诊断信息装在 result 里比降级成错误码有用。
func (h *Handler) DryRun(c *gin.Context) {
	var req DryRunRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		handler.BadRequest(c, "请求体不是合法 JSON")
		return
	}
	res, err := h.svc.DryRun(c.Request.Context(), req)
	if err != nil {
		handler.Fail(c, http.StatusInternalServerError, http.StatusInternalServerError, err.Error())
		return
	}
	handler.OK(c, res)
}

// DimValues 返回维度候选值，用于前端下拉枚举。
func (h *Handler) DimValues(c *gin.Context) {
	field := c.Query("field")
	if field == "" {
		handler.BadRequest(c, "缺少 field 参数")
		return
	}
	values, err := h.svc.DimValues(c.Request.Context(), c.Param("key"), field, tenantsFromContext(c), usersFromContext(c))
	if err != nil {
		writeQueryError(c, err)
		return
	}
	handler.OK(c, gin.H{"field": field, "values": values})
}

// writeQueryError 把错误映射为状态码。
// 用户看不到 SQL，所以执行失败时把引擎的原始错误透出，让他至少知道是哪里不对，
// 同时带 request_id，便于拿 id 去日志里捞完整 SQL。
func writeQueryError(c *gin.Context, err error) {
	switch {
	case errors.Is(err, repo.ErrNotFound):
		handler.Fail(c, http.StatusNotFound, http.StatusNotFound, err.Error())
	case errors.Is(err, ErrInvalidQuery):
		handler.BadRequest(c, err.Error())
	case errors.Is(err, ErrForbidden):
		handler.Fail(c, http.StatusForbidden, http.StatusForbidden, err.Error())
	default:
		handler.Fail(c, http.StatusBadRequest, http.StatusBadRequest, err.Error())
	}
}

func tenantsFromContext(c *gin.Context) []string {
	return middleware.CurrentTenants(c)
}

func usersFromContext(c *gin.Context) []string {
	return middleware.CurrentVisibleUsers(c)
}

func operatorFromContext(c *gin.Context) string {
	if v, ok := c.Get("operator"); ok {
		if s, ok := v.(string); ok && s != "" {
			return s
		}
	}
	return "system"
}
