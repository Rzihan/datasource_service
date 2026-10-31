package handler

import (
	"errors"
	"net/http"

	"dataset_service/internal/model"
	"dataset_service/internal/repo"
	"dataset_service/internal/service"

	"github.com/gin-gonic/gin"
)

// DashboardHandler 大盘的 HTTP 入口层。
type DashboardHandler struct {
	svc *service.DashboardService
}

// NewDashboardHandler 构造 handler。
func NewDashboardHandler(svc *service.DashboardService) *DashboardHandler {
	return &DashboardHandler{svc: svc}
}

// List 列出全部大盘。不分页：大盘是「几个页面」的量级。
func (h *DashboardHandler) List(c *gin.Context) {
	items, err := h.svc.List(c.Request.Context())
	if err != nil {
		writeError(c, err)
		return
	}
	OK(c, gin.H{"items": items})
}

// Get 查询单条大盘。
func (h *DashboardHandler) Get(c *gin.Context) {
	m, err := h.svc.Get(c.Request.Context(), c.Param("key"))
	if err != nil {
		writeErrorDashboard(c, err)
		return
	}
	OK(c, m)
}

// Create 新建大盘。
func (h *DashboardHandler) Create(c *gin.Context) {
	var req model.DashboardCreateRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		BadRequest(c, bindError(err))
		return
	}
	m, err := h.svc.Create(c.Request.Context(), &req, operator(c))
	if err != nil {
		writeErrorDashboard(c, err)
		return
	}
	c.JSON(http.StatusCreated, envelope{Code: 0, Message: "ok", Data: m, RequestID: requestID(c)})
}

// Update 更新大盘（乐观锁）。
func (h *DashboardHandler) Update(c *gin.Context) {
	var req model.DashboardUpdateRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		BadRequest(c, bindError(err))
		return
	}
	m, err := h.svc.Update(c.Request.Context(), c.Param("key"), &req, operator(c))
	if err != nil {
		writeErrorDashboard(c, err)
		return
	}
	OK(c, m)
}

// Delete 软删大盘。
func (h *DashboardHandler) Delete(c *gin.Context) {
	if err := h.svc.Delete(c.Request.Context(), c.Param("key")); err != nil {
		writeErrorDashboard(c, err)
		return
	}
	OK(c, gin.H{"key": c.Param("key")})
}

// writeErrorDashboard 大盘专属的错误翻译。
//
// 刻意不与 writeError 合并：key 非法是「参数写错了」，走 500 会让人以为
// 服务坏了。而大盘这个东西的所有写操作都来自人（编辑页面），
// 报错必须能直接指导下一步动作。
func writeErrorDashboard(c *gin.Context, err error) {
	switch {
	case err == nil:
		return
	case errors.Is(err, service.ErrDashboardInvalid):
		BadRequest(c, err.Error())
	case err == repo.ErrDashboardNotFound:
		Fail(c, http.StatusNotFound, http.StatusNotFound, err.Error())
	case err == repo.ErrDashboardDuplicateKey:
		Fail(c, http.StatusConflict, http.StatusConflict, err.Error())
	case err == repo.ErrDashboardVersionConflict:
		// 版本冲突单独给一句话：光报 status 409，前端只会弹一个红框。
		Fail(c, http.StatusConflict, http.StatusConflict, "这张大盘被别人改过了，请刷新后重试")
	default:
		writeError(c, err)
	}
}
