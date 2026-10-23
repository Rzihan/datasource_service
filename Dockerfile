# ---------- 阶段 1：构建前端 ----------
FROM node:22-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
# 输出到 /web/dist（覆盖 vite.config 里默认的 ../internal/web/dist），
# 下一阶段再复制到 Go 的 embed 目录。
RUN npm run build -- --outDir dist

# ---------- 阶段 2：编译后端 ----------
FROM golang:1.26-alpine AS server
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# 前端产物放进 internal/web/dist，由 //go:embed all:dist 打进二进制
COPY --from=web /web/dist ./internal/web/dist
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/datasource-service ./cmd/server

# ---------- 阶段 3：运行 ----------
# 用 alpine 而非 distroless：gcr.io 在国内网络下经常拉不到。
# 若环境可访问 gcr.io，可换成 gcr.io/distroless/static-debian12:nonroot，镜像更小。
FROM alpine:3.21
RUN apk add --no-cache ca-certificates tzdata && \
    addgroup -g 10001 -S app && adduser -u 10001 -S app -G app
WORKDIR /app
COPY --from=server /out/datasource-service /app/datasource-service
USER app:app
EXPOSE 8080
ENTRYPOINT ["/app/datasource-service"]
