package router

import (
	"io/fs"
	"log/slog"
	"mime"
	"net/http"
	"os"
	"path"
	"regexp"
	"strings"

	"dataset_service/internal/config"
	"dataset_service/internal/handler"
	"dataset_service/internal/middleware"
	"dataset_service/internal/query"
	"dataset_service/internal/web"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// Deps 组装路由所需的依赖。
type Deps struct {
	Config *config.Config
	DB     *gorm.DB
	DS     *handler.DatasetHandler
	LH     *handler.LabelHandler
	QH     *query.Handler
}

// New 构建 gin 引擎：API 路由 + 前端静态资源 + SPA fallback。
func New(d Deps) *gin.Engine {
	gin.SetMode(d.Config.GinMode)
	r := gin.New()
	r.Use(gin.Recovery())
	r.Use(middleware.RequestID(d.Config.RequestIDHdr))
	r.Use(middleware.Operator("X-User"))
	r.Use(middleware.Tenants("X-Tenants"))
	r.Use(middleware.VisibleUsers("X-Visible-Users"))
	r.Use(middleware.Logger())
	r.Use(middleware.CORS())

	// 探针不进访问日志噪音，直接挂在根上。
	r.GET("/healthz", handler.Healthz)
	r.GET("/readyz", handler.NewReadyz(d.DB))

	v1 := r.Group("/api/v1")
	{
		v1.POST("/datasets/validate", d.DS.Validate)
		v1.GET("/datasets", d.DS.List)
		v1.POST("/datasets", d.DS.Create)
		v1.GET("/datasets/:key", d.DS.Get)
		v1.PUT("/datasets/:key", d.DS.Update)
		v1.DELETE("/datasets/:key", d.DS.Delete)
		// 变更历史与回滚：配置写错了能一键退回
		v1.GET("/datasets/:key/histories", d.DS.Histories)
		v1.POST("/datasets/:key/rollback", d.DS.Rollback)

		// 全局字段名称定义（对所有数据集生效的「字段名 → 中文名」字典）
		v1.GET("/labels", d.LH.List)
		v1.POST("/labels", d.LH.Create)
		v1.GET("/labels/:key", d.LH.Get)
		v1.PUT("/labels/:key", d.LH.Update)
		v1.DELETE("/labels/:key", d.LH.Delete)
		// 下面两个刻意不挂在 /labels 下：/labels/:key 的通配段会与同级静态段冲突。
		// 全量字典，供数据集编辑页显示「继承：XXX」
		v1.GET("/label-map", d.LH.Map)
		// 一致性检查：冲突 / 大小写不生效 / 缺失 / 孤儿
		v1.GET("/label-check", d.LH.Check)

		// 查询页可选的数据集，已按登录态租户过滤
		v1.GET("/query/datasets", d.QH.Datasets)
		// 查询只暴露一个执行接口：前端传「查询意图」，SQL 由后端生成，用户不感知。
		v1.POST("/query/execute", d.QH.Execute)
		// 维度候选值，供前端下拉枚举
		v1.GET("/datasets/:key/dim-values", d.QH.DimValues)
	}

	source := mountSPA(r, d.Config.StaticDir)
	slog.Info("frontend source resolved", "source", source, "static_dir", d.Config.StaticDir)
	return r
}

// bundlePattern 从 index.html 里抠出入口 JS 文件名。
// 启动时打印它，是为了让「我改了前端但页面没变」这类问题一眼可查：
// 浏览器 Network 里看到的 bundle 名必须与日志一致。
var bundlePattern = regexp.MustCompile(`/assets/(index-[A-Za-z0-9_.-]+\.js)`)

// mountSPA 挂载前端静态资源。
//   - StaticDir 非空（开发态）：直接从磁盘读取，改前端无需重编译 Go。
//   - 否则使用 go:embed 的 dist。
//
// 未命中的非 API 路径统一回落到 index.html，保证前端路由刷新不 404。
func mountSPA(r *gin.Engine, staticDir string) string {
	var fsys fs.FS
	source := "embed"
	if staticDir != "" {
		if _, err := os.Stat(staticDir); err == nil {
			fsys = os.DirFS(staticDir)
			source = "disk"
		} else {
			// 这里刻意打日志：目录不存在会静默回退到编译期 embed 的旧产物，
			// 表现是「改了前端但页面没变」，很难排查。
			slog.Warn("STATIC_DIR not found, falling back to embedded frontend", "dir", staticDir)
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
		return "none"
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
			// index.html 必须每次回源。用 no-store 而不是 no-cache：
			// 只给 no-cache 时，部分内嵌预览/会话恢复场景仍会复用旧 HTML，
			// 于是继续加载已被删掉的旧 JS，表现为「改了前端但页面没变」。
			c.Header("Cache-Control", "no-store, must-revalidate")
			c.Header("Pragma", "no-cache")
			c.Header("Expires", "0")
		}
		c.Data(http.StatusOK, ct, data)
		return true
	}

	if data, err := fs.ReadFile(fsys, "index.html"); err == nil {
		if m := bundlePattern.FindSubmatch(data); m != nil {
			slog.Info("frontend bundle resolved", "bundle", string(m[1]), "source", source)
		}
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
	return source
}
