package handler

import (
	"net/http"
	"time"

	"dataset_service/internal/repo"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// Healthz 存活探针：进程还在就返回 200，不依赖任何外部组件。
func Healthz(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"status": "up"})
}

// NewReadyz 就绪探针：数据库不可用时返回 503，让编排系统把实例摘掉。
func NewReadyz(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		if err := repo.PingDB(db, 2*time.Second); err != nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"status": "down", "reason": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"status": "up"})
	}
}
