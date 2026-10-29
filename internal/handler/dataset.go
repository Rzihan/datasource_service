package handler

import (
	"errors"
	"net/http"
	"strconv"
	"strings"

	"dataset_service/internal/model"
	"dataset_service/internal/repo"
	"dataset_service/internal/service"

	"github.com/gin-gonic/gin"
)

// DatasetHandler 配置的 HTTP 入口层，只做参数绑定与错误码映射，不含业务规则。
type DatasetHandler struct {
	svc *service.DatasetService
}

// NewDatasetHandler 构造 handler。
func NewDatasetHandler(svc *service.DatasetService) *DatasetHandler {
	return &DatasetHandler{svc: svc}
}

// List 分页列表。
func (h *DatasetHandler) List(c *gin.Context) {
	q := model.ListQuery{
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

// Get 查询详情。
func (h *DatasetHandler) Get(c *gin.Context) {
	m, err := h.svc.Get(c.Request.Context(), c.Param("key"))
	if err != nil {
		writeError(c, err)
		return
	}
	OK(c, m)
}

// Create 新建。
func (h *DatasetHandler) Create(c *gin.Context) {
	var req model.CreateRequest
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

// Update 全量更新（乐观锁）。
func (h *DatasetHandler) Update(c *gin.Context) {
	var req model.UpdateRequest
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
func (h *DatasetHandler) Delete(c *gin.Context) {
	if err := h.svc.Delete(c.Request.Context(), c.Param("key"), operator(c)); err != nil {
		writeError(c, err)
		return
	}
	OK(c, gin.H{"dataset_key": c.Param("key")})
}

// Histories 变更历史列表（按时间倒序）。
func (h *DatasetHandler) Histories(c *gin.Context) {
	limit := atoiDefault(c.Query("limit"), 50)
	if limit > 200 {
		limit = 200
	}
	res, err := h.svc.Histories(c.Request.Context(), c.Param("key"), limit)
	if err != nil {
		writeError(c, err)
		return
	}
	OK(c, res)
}

// Rollback 把配置恢复到某条历史记录的样子。
func (h *DatasetHandler) Rollback(c *gin.Context) {
	var req model.RollbackRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		BadRequest(c, bindError(err))
		return
	}
	m, err := h.svc.Rollback(c.Request.Context(), c.Param("key"), &req, operator(c))
	if err != nil {
		writeError(c, err)
		return
	}
	OK(c, m)
}

// Validate 只校验不落库，供前端实时反馈。
func (h *DatasetHandler) Validate(c *gin.Context) {
	var req model.ValidateRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		BadRequest(c, bindError(err))
		return
	}
	if err := h.svc.Validate(c.Request.Context(), &req); err != nil {
		writeError(c, err)
		return
	}
	OK(c, gin.H{"valid": true})
}

// writeError 把领域错误映射为 HTTP 状态码。
func writeError(c *gin.Context, err error) {
	switch {
	case errors.Is(err, repo.ErrNotFound):
		Fail(c, http.StatusNotFound, http.StatusNotFound, err.Error())
	case errors.Is(err, repo.ErrHistoryNotFound):
		Fail(c, http.StatusNotFound, http.StatusNotFound, err.Error())
	case errors.Is(err, repo.ErrHistoryMismatch):
		BadRequest(c, err.Error())
	case errors.Is(err, repo.ErrDuplicateKey):
		Fail(c, http.StatusConflict, http.StatusConflict, err.Error())
	case errors.Is(err, repo.ErrVersionConflict):
		Fail(c, http.StatusConflict, http.StatusConflict, err.Error())
	case errors.Is(err, repo.ErrLabelNotFound):
		Fail(c, http.StatusNotFound, http.StatusNotFound, err.Error())
	case errors.Is(err, repo.ErrLabelDuplicateKey):
		Fail(c, http.StatusConflict, http.StatusConflict, err.Error())
	case errors.Is(err, repo.ErrLabelVersionConflict):
		Fail(c, http.StatusConflict, http.StatusConflict, err.Error())
	case errors.Is(err, service.ErrInvalid):
		BadRequest(c, err.Error())
	default:
		Fail(c, http.StatusInternalServerError, http.StatusInternalServerError, "internal error")
	}
}

// operator 取操作人，由 middleware 从 X-User 头注入。
func operator(c *gin.Context) string {
	if v, ok := c.Get("operator"); ok {
		if s, ok := v.(string); ok && s != "" {
			return s
		}
	}
	return "system"
}

// bindError 把 gin 的反序列化错误翻译成人话。
// 默认的 "cannot unmarshal number into Go struct field ..." 会把内部结构体名暴露出去。
func bindError(err error) string {
	msg := err.Error()
	if strings.Contains(msg, "cannot unmarshal") {
		return "字段类型不匹配：dim_map / mtx_map 的值必须是字符串，status 必须是 0 或 1"
	}
	return "请求体不是合法 JSON"
}

func atoiDefault(s string, def int) int {
	if s == "" {
		return def
	}
	v, err := strconv.Atoi(s)
	if err != nil || v <= 0 {
		return def
	}
	return v
}
