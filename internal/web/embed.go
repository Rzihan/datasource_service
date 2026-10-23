package web

import (
	"embed"
	"io/fs"
)

// dist 目录由前端 `pnpm build` 产出。Dockerfile 会把 web/dist 复制进来，
// 因此最终二进制自带前端，部署时只需要一个容器、一个端口。
//
//go:embed all:dist
var dist embed.FS

// FS 返回 dist 子树的只读文件系统。
func FS() fs.FS {
	sub, err := fs.Sub(dist, "dist")
	if err != nil {
		panic("web: dist directory is not embedded: " + err.Error())
	}
	return sub
}
