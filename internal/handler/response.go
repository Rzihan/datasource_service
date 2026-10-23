package handler

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

// envelope 是统一响应结构。code 为 0 表示成功，其余为业务错误码。
type envelope struct {
	Code      int         `json:"code"`
	Message   string      `json:"message"`
	Data      interface{} `json:"data,omitempty"`
	RequestID string      `json:"request_id"`
}

// OK 返回成功响应。
func OK(c *gin.Context, data interface{}) {
	c.JSON(http.StatusOK, envelope{
		Code:      0,
		Message:   "ok",
		Data:      data,
		RequestID: requestID(c),
	})
}

// Fail 返回错误响应。
func Fail(c *gin.Context, status, code int, msg string) {
	c.JSON(status, envelope{
		Code:      code,
		Message:   msg,
		RequestID: requestID(c),
	})
}

// BadRequest 400 便捷方法。
func BadRequest(c *gin.Context, msg string) {
	Fail(c, http.StatusBadRequest, http.StatusBadRequest, msg)
}

func requestID(c *gin.Context) string {
	if v, ok := c.Get("request_id"); ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}
