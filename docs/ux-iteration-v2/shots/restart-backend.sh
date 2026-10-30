#!/bin/zsh
# 本地起后端做迭代验证（替代容器里的 app，改完 Go 代码 restart 一下即可）。
# 用 gitignore 之外的临时目录放二进制，避免放到仓库里被提交。
cd /Users/Zhuanz/GolandProjects/datasource_service || exit 1
pkill -f "ds-server" 2>/dev/null
sleep 1
go build -o /tmp/ds-server ./cmd/server || exit 1
HTTP_PORT=8080 \
GIN_MODE=debug \
DB_HOST=127.0.0.1 DB_PORT=3306 DB_USER=dataset DB_PASSWORD=dataset_pass DB_NAME=dataset_service \
MAX_SQL_BYTES=1048576 \
CH_HOST=127.0.0.1 CH_PORT=9000 CH_USER=reader CH_PASSWORD=reader_pass CH_DB=demo \
STATIC_DIR=internal/web/dist \
  /tmp/ds-server
