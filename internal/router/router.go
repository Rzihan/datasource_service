package router

import (
	"io/fs"
	"mime"
	"net/http"
	"os"
	"path"
	"strings"

	"datasource_service/internal/config"
	"datasource_service/internal/handler"
	"datasource_service/internal/middleware"
	"datasource_service/internal/web"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// Deps 组装路由所需的依赖。
type Deps struct {
	Config *config.Config
	DB     *gorm.DB
	DS     *handler.DatasourceHandler
}

// New 构建 gin 引擎：API 路由 + 前端静态资源 + SPA fallback。
func New(d Deps) *gin.Engine {
	gin.SetMode(d.Config.GinMode)
	r := gin.New()
	r.Use(gin.Recovery())
	r.Use(middleware.RequestID(d.Config.RequestIDHdr))
	r.Use(middleware.Operator("X-User"))
	r.Use(middleware.Logger())
	r.Use(middleware.CORS())

	// 探针不进访问日志噪音，直接挂在根上。
	r.GET("/healthz", handler.Healthz)
	r.GET("/readyz", handler.NewReadyz(d.DB))

	v1 := r.Group("/api/v1")
	{
		v1.POST("/datasources/validate", d.DS.Validate)
		v1.GET("/datasources", d.DS.List)
		v1.POST("/datasources", d.DS.Create)
		v1.GET("/datasources/:key", d.DS.Get)
		v1.PUT("/datasources/:key", d.DS.Update)
		v1.DELETE("/datasources/:key", d.DS.Delete)
	}

	mountSPA(r, d.Config.StaticDir)
	return r
}

// mountSPA 挂载前端静态资源。
//   - StaticDir 非空（开发态）：直接从磁盘读取，改前端无需重编译 Go。
//   - 否则使用 go:embed 的 dist。
//
// 未命中的非 API 路径统一回落到 index.html，保证前端路由刷新不 404。
func mountSPA(r *gin.Engine, staticDir string) {
	var fsys fs.FS
	if staticDir != "" {
		if _, err := os.Stat(staticDir); err == nil {
			fsys = os.DirFS(staticDir)
		}
	}
	if fsys == nil {
		fsys = web.FS()
	}
	if fsys == nil {
		// 没有任何前端资源时（例如只跑后端单元测试），API 仍然可用。
		r.NoRoute(func(c *gin.Context) {
			c.JSON(http.StatusNotFound, gin.H{"code": 404, "message": "not found"})
		})
		return
	}

	// 这里刻意不使用 gin 的 c.FileFromFS：它会把 URL.Path 改写成目标文件名，
	// 而 http.FileServer 规定「路径以 index.html 结尾时重定向到 ./」，
	// 两者叠加会让首页返回 301 Location: ./。直接读文件内容输出最稳。
	serveFile := func(c *gin.Context, name string) bool {
		data, err := fs.ReadFile(fsys, name)
		if err != nil {
			return false
		}
		ct := mime.TypeByExtension(path.Ext(name))
		if ct == "" {
			ct = "application/octet-stream"
		}
		if strings.HasPrefix(name, "assets/") {
			// 构建产物文件名带内容哈希，可以放心长缓存
			c.Header("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			c.Header("Cache-Control", "no-cache")
		}
		c.Data(http.StatusOK, ct, data)
		return true
	}

	index := func(c *gin.Context) {
		if !serveFile(c, "index.html") {
			c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "index.html missing"})
		}
	}

	r.GET("/", index)
	r.GET("/favicon.ico", func(c *gin.Context) {
		if !serveFile(c, "favicon.ico") {
			c.Status(http.StatusNoContent)
		}
	})
	r.NoRoute(func(c *gin.Context) {
		if strings.HasPrefix(c.Request.URL.Path, "/api/") {
			c.JSON(http.StatusNotFound, gin.H{"code": 404, "message": "api not found"})
			return
		}
		// 带扩展名的路径视为静态资源，找不到就 404；其余回落到 index.html 交给前端路由。
		p := strings.TrimPrefix(path.Clean(c.Request.URL.Path), "/")
		if p != "." && p != "" && strings.Contains(path.Base(p), ".") {
			if !serveFile(c, p) {
				c.JSON(http.StatusNotFound, gin.H{"code": 404, "message": "asset not found"})
			}
			return
		}
		index(c)
	})
}
