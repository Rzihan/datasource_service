# 基础镜像默认走加速源：docker.io 在部分网络下直接 Bad Gateway，
# 用官方名会连 FROM 都解析不了。环境能直连时把下面三个改回官方名即可
# （node:22-alpine / golang:1.26-alpine / alpine:3.21）。
ARG NODE_IMAGE=docker.1ms.run/library/node:22-alpine
ARG GO_IMAGE=docker.1ms.run/library/golang:1.26-alpine
ARG RUNTIME_IMAGE=docker.1ms.run/library/alpine:3.21
ARG GOPROXY=https://goproxy.cn,direct
ARG NPM_REGISTRY=https://registry.npmmirror.com

# ---------- 阶段 1：构建前端 ----------
FROM ${NODE_IMAGE} AS web
ARG NPM_REGISTRY
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund --registry="$NPM_REGISTRY"
COPY web/ ./
# 输出到 /web/dist（覆盖 vite.config 里默认的 ../internal/web/dist），
# 下一阶段再复制到 Go 的 embed 目录。
RUN npm run build -- --outDir dist

# ---------- 阶段 2：编译后端 ----------
FROM ${GO_IMAGE} AS server
ARG GOPROXY
WORKDIR /src
COPY go.mod go.sum ./
RUN GOPROXY="$GOPROXY" go mod download
COPY . .
# 前端产物放进 internal/web/dist，由 //go:embed all:dist 打进二进制
COPY --from=web /web/dist ./internal/web/dist
RUN CGO_ENABLED=0 GOPROXY="$GOPROXY" go build -trimpath -ldflags="-s -w" -o /out/dataset-service ./cmd/server

# ---------- 阶段 3：运行 ----------
# 用 alpine 而非 distroless：gcr.io 在国内网络下经常拉不到。
# 若环境可访问 gcr.io，可换成 gcr.io/distroless/static-debian12:nonroot，镜像更小。
FROM ${RUNTIME_IMAGE}
RUN apk add --no-cache ca-certificates tzdata && \
    addgroup -g 10001 -S app && adduser -u 10001 -S app -G app
WORKDIR /app
COPY --from=server /out/dataset-service /app/dataset-service
USER app:app
EXPOSE 8080
ENTRYPOINT ["/app/dataset-service"]
