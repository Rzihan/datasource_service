package handler

import (
	"net/http"
	"strconv"

	"dataset_service/internal/model"
	"dataset_service/internal/service"

	"github.com/gin-gonic/gin"
)

// LabelHandler 全局字段名称定义的 HTTP 入口层。
type LabelHandler struct {
	svc *service.LabelService
}

// NewLabelHandler 构造 handler。
func NewLabelHandler(svc *service.LabelService) *LabelHandler {
	return &LabelHandler{svc: svc}
}

// List 分页列表。
func (h *LabelHandler) List(c *gin.Context) {
	q := model.GlobalLabelListQuery{
		Keyword: c.Query("keyword"),
		Page:    atoiDefault(c.Query("page"), 1),
		Size:    atoiDefault(c.Query("size"), 20),
	}
	if s := c.Query("status"); s != "" {
		if v, err := strconv.ParseInt(s, 10, 8); err == nil {
			st := int8(v)
			q.Status = &st
		} else {
			BadRequest(c, "status must be 0 or 1")
			return
		}
	}
	res, err := h.svc.List(c.Request.Context(), q)
	if err != nil {
		writeError(c, err)
		return
	}
	OK(c, res)
}

// Map 返回全量字典，供数据集编辑页显示「继承：XXX」提示。
// 单独开一个接口而不是复用 List：列表分页最多 200 条，字典可能超过，
// 而且这里只需要 key→value，不需要分页和审计字段。
func (h *LabelHandler) Map(c *gin.Context) {
	OK(c, gin.H{"label_map": h.svc.Map(c.Request.Context())})
}

// Get 查询详情。
func (h *LabelHandler) Get(c *gin.Context) {
	m, err := h.svc.Get(c.Request.Context(), c.Param("key"))
	if err != nil {
		writeError(c, err)
		return
	}
	OK(c, m)
}

// Create 新建。
func (h *LabelHandler) Create(c *gin.Context) {
	var req model.GlobalLabelCreateRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		BadRequest(c, bindError(err))
		return
	}
	m, err := h.svc.Create(c.Request.Context(), &req, operator(c))
	if err != nil {
		writeError(c, err)
		return
	}
	c.JSON(http.StatusCreated, envelope{Code: 0, Message: "ok", Data: m, RequestID: requestID(c)})
}

// Update 更新（乐观锁）。
func (h *LabelHandler) Update(c *gin.Context) {
	var req model.GlobalLabelUpdateRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		BadRequest(c, bindError(err))
		return
	}
	m, err := h.svc.Update(c.Request.Context(), c.Param("key"), &req, operator(c))
	if err != nil {
		writeError(c, err)
		return
	}
	OK(c, m)
}

// Delete 软删除。
func (h *LabelHandler) Delete(c *gin.Context) {
	if err := h.svc.Delete(c.Request.Context(), c.Param("key"), operator(c)); err != nil {
		writeError(c, err)
		return
	}
	OK(c, gin.H{"field_key": c.Param("key")})
}
