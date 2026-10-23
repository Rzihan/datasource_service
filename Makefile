GO ?= go
NPM ?= npm
BIN := bin/datasource-service

.PHONY: help tidy vet test build run web-install web-dev web-build up down logs clean

help:
	@echo "make web-install   安装前端依赖"
	@echo "make web-dev       启动前端开发服务 (5173)，需后端已在 8080 运行"
	@echo "make run           以开发模式启动后端 (8080)"
	@echo "make web-build     构建前端到 internal/web/dist"
	@echo "make build         构建前端并编译 Go 二进制"
	@echo "make up            docker compose 一键启动（含 MySQL）"
	@echo "make down          停止 docker compose"
	@echo "make logs          查看 app 日志"
	@echo "make vet           go vet 静态检查"

tidy:
	$(GO) mod tidy

vet:
	$(GO) vet ./...

test:
	$(GO) test ./... -count=1

# 开发：后端用 STATIC_DIR 指向前端构建产物，改前端不用重编译 Go
run:
	STATIC_DIR=internal/web/dist GIN_MODE=debug $(GO) run ./cmd/server

web-install:
	cd web && $(NPM) install

web-dev:
	cd web && $(NPM) run dev

web-build:
	cd web && $(NPM) run build

build: web-build
	$(GO) build -trimpath -ldflags="-s -w" -o $(BIN) ./cmd/server

up:
	docker compose up -d --build

down:
	docker compose down

logs:
	docker compose logs -f app

clean:
	rm -rf bin
