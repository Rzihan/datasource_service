# datasource_service

datasource 配置的增删改查服务。一条配置包含五个字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `datasource_key` | varchar(64) | 业务主键，全局唯一，强制小写 |
| `datasource_name` | varchar(128) | 展示名 |
| `mid_sql` | mediumtext | 中间层 SQL，**纯文本存储，不做语法/语义校验** |
| `dim_map` | json | 维度映射，`map[string]string` |
| `mtx_map` | json | 指标映射，`map[string]string` |

技术栈：Go 1.26 + gin + GORM + MySQL 8.0 / React 18 + TypeScript + Vite + Ant Design 5 + Monaco / Docker Compose。

## 快速开始

```bash
docker compose up -d --build   # 构建并启动 app + mysql
open http://localhost:8080
```

MySQL 首次启动会自动执行 `deploy/mysql/init.sql` 建库建表，数据落在 named volume `mysql-data`。

## 本地开发

前端用 Vite dev server（5173），API 请求代理到本机 8080：

```bash
# 终端 1：起 MySQL
docker compose up -d mysql
# 终端 2：起后端
make run
# 终端 3：起前端
make web-install && make web-dev
```

后端通过 `STATIC_DIR=internal/web/dist` 从磁盘读前端产物，改前端无需重编译 Go。

## 目录结构

```
cmd/server           程序入口：依赖装配、优雅退出
internal/config      环境变量 → 配置
internal/model       实体与 DTO
internal/repo        GORM 数据访问（含软删、乐观锁）
internal/service     业务规则与入参校验
internal/handler     gin handler，只做绑定与错误码映射
internal/middleware  request-id / 操作人 / 访问日志 / CORS
internal/router      路由与前端静态资源挂载
internal/web         go:embed 前端产物
web                  React 前端
deploy/mysql         init.sql 建表脚本
```

## API

基址 `/api/v1`，统一响应 `{ code, message, data, request_id }`，`code = 0` 为成功。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/datasources` | 分页列表，参数 `page` `size` `keyword` `status` |
| GET | `/datasources/:key` | 详情 |
| POST | `/datasources` | 新建，key 冲突返回 409 |
| PUT | `/datasources/:key` | 全量更新，带 `version` 乐观锁，冲突返回 409 |
| DELETE | `/datasources/:key` | 软删除 |
| POST | `/datasources/validate` | 只校验 dim_map / mtx_map，不落库 |
| GET | `/healthz` `/readyz` | 存活 / 就绪探针（readyz 会 ping 数据库） |

示例：

```bash
curl -X POST localhost:8080/api/v1/datasources \
  -H 'Content-Type: application/json' -H 'X-User: zhangsan' \
  -d '{
    "datasource_key": "order_daily",
    "datasource_name": "订单日报",
    "mid_sql": "select stat_date, sum(stat_cost) as cost from t_order group by stat_date",
    "dim_map": {"date": "stat_date"},
    "mtx_map": {"cost": "sum(stat_cost)", "click": "sum(clicks)", "uid": "uid"}
  }'
```

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HTTP_PORT` | 8080 | 监听端口 |
| `GIN_MODE` | release | `debug` 会打印 SQL |
| `DB_HOST` / `DB_PORT` | mysql / 3306 | 数据库地址 |
| `DB_USER` / `DB_PASSWORD` / `DB_NAME` | datasource / - / datasource_service | 数据库凭据 |
| `DB_MAX_OPEN` / `DB_MAX_IDLE` | 50 / 10 | 连接池上限 |
| `DB_MAX_LIFETIME_SECONDS` | 1800 | 连接最大复用时长 |
| `MAX_SQL_BYTES` | 1048576 | mid_sql 字节软上限，防存储被撑爆 |
| `STATIC_DIR` | 空 | 非空则从磁盘读前端资源（开发用），否则用 embed |
| `DB_AUTO_MIGRATE` | false | 设为 true 时启动自动对齐表结构 |
| `SHUTDOWN_WAIT_SECONDS` | 15 | 优雅退出最长等待时间 |

## 几个刻意的设计取舍

1. **`mid_sql` 用 `MEDIUMTEXT` 而非 `TEXT`**。TEXT 上限 65535 **字节**，长 SQL 很容易贴着天花板，
   溢出时报错发生在保存那一刻，用户写的东西可能白写。InnoDB 下两者行内占用完全一样
   （都只存指针 + 前缀，正文放溢出页），换 MEDIUMTEXT 成本为零。

2. **软删除的 `deleted_at` 是 `BIGINT` 而非 GORM 内置的 `gorm.DeletedAt`**。
   后者是 `DATETIME NULL` 语义，而 MySQL 唯一索引中 NULL 之间互不冲突——
   多条 `deleted_at IS NULL` 的同名记录可以并存，唯一约束形同虚设。
   改用 `0 / 毫秒时间戳` 并让 `deleted_at` 参与联合唯一键
   `uk_datasource_key(datasource_key, deleted_at)`，才能真正约束住，同时允许删了再建同名 key。

3. **`datasource_key` 强制小写**。MySQL 默认 collation `utf8mb4_0900_ai_ci` 不区分大小写，
   `Order_DS` 与 `order_ds` 会被判为同一条。前端与后端都会把 key 规范化为小写。

4. **`dim_map` / `mtx_map` 不引入 JSON Schema，靠类型系统校验**。
   它们就是 `map[string]string`，gin 绑定时非字符串的值会被直接拒绝，
   GORM 读取时同理。省掉一个依赖，规则也不会前后端分裂。

5. **更新带乐观锁**。两人同时编辑同一条配置时，后提交者收到 409 而不是静默覆盖。

6. **单容器交付**。前端产物 `go:embed` 进二进制，部署只有一个镜像、一个端口，
   不需要 nginx 也不需要对象存储。

## 已知边界

- `mid_sql` 不做任何校验，写错的 SQL 要等下游执行时才暴露。列表页会截断展示 SQL，方便肉眼扫一遍。
- 系统不接鉴权，操作人来自请求头 `X-User`（前端右上角填写，存 localStorage），
  仅用于审计字段 `created_by` / `updated_by`。如需接入 SSO，在 `middleware.Operator` 处替换即可。
- 没有变更历史表。如需回滚能力，加一张 `datasource_config_history` 在 service 的写路径上插快照即可。
