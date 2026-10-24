# datasource_service

datasource 配置的增删改查服务。一条配置包含五个字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `datasource_key` | varchar(64) | 业务主键，全局唯一，强制小写 |
| `datasource_name` | varchar(128) | 展示名 |
| `mid_sql` | mediumtext | 中间层 SQL，**纯文本存储，不做语法/语义校验** |
| `dim_map` | json | 维度映射，`map[string]string` |
| `mtx_map` | json | 指标映射，`map[string]string` |
| `label_map` | json | 维度/指标的中文含义，`map[string]string`，**只影响展示**，不参与 SQL 生成 |

技术栈：Go 1.26 + gin + GORM + MySQL 8.0 / React 18 + TypeScript + Vite + Ant Design 5 + Monaco / Docker Compose。

## 快速开始

```bash
docker compose up -d --build   # 构建并启动 app + mysql
open http://localhost:8080
```

MySQL 首次启动会自动执行 `deploy/mysql/init.sql` 建库建表，数据落在 named volume `mysql-data`。

存量环境升级（已建过表、缺 `label_map` 列）执行：

```bash
mysql < deploy/mysql/migrate_add_label_map.sql
```

## 起一套 ClickHouse 演示环境

```bash
docker compose up -d clickhouse
```

容器首次启动会执行 `deploy/clickhouse/init.sql`：

- 建库 `demo`、建表 `demo.t_order_dtl`，灌入 **5000 行**演示数据
  （含 `Date`、`Nullable(String)`、`Decimal(18,2)`、`UInt64` 等各种类型）
- 建只读账号 **`reader` / `reader_pass`**，服务就用它连接

### ClickHouse 的可视化界面

| 方式 | 地址 / 命令 | 说明 |
| --- | --- | --- |
| **自带 Web 控制台**（推荐先用这个） | http://localhost:8123/play | ClickHouse 内置，零额外组件。登录用 `reader` / `reader_pass`（只读）或 `datasource` / `ch_pass` |
| **DBeaver**（功能最全） | `brew install --cask dbeaver-community` | 图形化客户端：浏览表结构、预览数据、建表改表、看执行计划 |
| 本项目查询页 | http://localhost:8080/query | 面向业务用户的查数界面，不写 SQL |

只想快速跑一条 SQL，也可以直接用 HTTP 接口：

```bash
curl 'http://localhost:8123/?user=reader&password=reader_pass' \
  --data-urlencode 'query=SELECT city_code, sum(stat_cost) FROM demo.t_order_dtl GROUP BY city_code'
```

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

## 两个页面

| 路由 | 功能 |
| --- | --- |
| `/datasources` | 配置管理：datasource 的增删改查 |
| `/query` | 可视化查询：选数据源 → 选维度/指标 → 加过滤 → 查数 → 看表格和图表 |

## 可视化查询怎么工作

用户不接触 SQL，只描述「想看什么」：

```jsonc
// POST /api/v1/query/execute
{
  "datasource_key": "order_daily",
  "dims":    ["date", "city"],        // 必须是该数据源 dim_map 里的 key
  "metrics": ["cost", "click"],       // 必须是该数据源 mtx_map 里的 key
  // 过滤条件树：分组节点用 and / or 连接，可任意嵌套
  "filter": {
    "logic": "and",
    "children": [
      {"field": "city", "op": "=", "value": "北京"},
      {"logic": "or", "children": [
        {"field": "cost",  "op": ">", "value": "1000"},
        {"field": "click", "op": "<", "value": "100"}
      ]}
    ]
  },
  "order_by":[{"field": "cost", "desc": true}],
  "limit":   1000                      // 服务端 clamp 到 QUERY_MAX_ROWS
}
```

后端据此生成 SQL 并在 ClickHouse 上执行：

```sql
SELECT stat_date AS `date`, city_code AS `city`, sum(stat_cost) AS `cost`
FROM ( <mid_sql> ) AS __mid
WHERE city_code = {p0:String}
GROUP BY stat_date, city_code
HAVING (`cost` > {p1:Float64} OR `click` < {p2:Float64})
ORDER BY `cost` DESC
LIMIT 1000
```

### 过滤条件树：AND / OR 怎么落到 WHERE / HAVING

过滤条件是一棵树：分组节点带 `logic`（`and` / `or`）和 `children`，叶子节点带
`field` / `op` / `value`（`in` / `not in` 用 `values`）。分组可嵌套，所以
`A AND (B OR C)` 这种组合表达得出来。

编译成 SQL 时要面对一个现实：**维度条件是行级的（聚合前），指标条件只有聚合后才有值**。
处理方式：

- **AND 可以拆**：能下压的子条件进 `WHERE`（少聚合很多行），压不下去的进 `HAVING`，
  两段用 AND 连接后与原意等价。
- **OR 不能拆**：一旦一部分进 `WHERE`、另一部分进 `HAVING`，两段之间就变成 AND 了，
  语义完全变了。所以 OR 整组必须能待在同一段里——优先 `WHERE`，不行才 `HAVING`。
- **已勾选的维度聚合后仍有这一列**，所以可以和指标用 OR 组合（整组进 `HAVING`）。
- **未勾选的维度只在聚合前有意义**，和指标用 OR 连接是算不出来的，直接返回明确错误：
  `这组 OR 条件算不出来：其中既有只能在聚合前判断的条件（未勾选的维度），又有只能在聚合后判断的条件（指标）`。

规模上限：嵌套不超过 5 层、节点不超过 64 个（`MaxFilterDepth` / `MaxFilterNodes`）。
条件树是用户自由构造的递归结构，不给上限的话一个深嵌套就能把组装和解析都拖垮。

约定：`mid_sql` 的输出是**可以被再次聚合的中间结果**，外层按用户选的维度重新聚合，
指标口径统一、不会重复计算。所以 `mid_sql` 里不要写 `ORDER BY` / `LIMIT`（先截断再聚合，结果会错）。

**查询的三道防线**（都是硬限制，不是优化项）：

1. 行数：默认 1000，服务端硬顶 `QUERY_MAX_ROWS`（默认 10000），超出截断并回传 `truncated: true`
2. 超时：`context` 超时 + ClickHouse `max_execution_time` 双管齐下（默认 30s）——只靠 context 取消，CH 端的查询不一定立刻终止
3. 并发：全局闸门 `QUERY_MAX_CONCURRENCY`（默认 8），防止几个人各点几个大查询把 CH 拖垮

**安全**：`dims` / `metrics` / `order_by` / 过滤字段全部走白名单枚举校验，前端没有任何通道塞进任意 SQL；
唯一的自由输入是过滤值，通过 ClickHouse 命名参数绑定，不参与字符串拼接。

**维度过滤与指标过滤**：过滤条件树的叶子 `field` 可以是 `dim_map` 的键，也可以是 `mtx_map` 的键。
前者落到 `WHERE`（先筛行再聚合），后者落到 `HAVING`（先聚合再筛结果），两者语义不同，必须分开。
**指标必须是已勾选的指标**——没勾选就不会出现在结果里，拿它过滤用户看不到任何依据，
所以后端直接拒绝（`过滤指标 "x" 未被勾选`），前端的下拉里也只列出已勾选的指标。
取消勾选指标时，挂在该指标上的过滤条件会联动清除，清除前弹确认告诉用户要动哪些条件。
指标的值若能解析成数字就绑成 `Float64`，否则退回 `String`——ClickHouse 不允许 `Decimal` 与 `String`
直接比较，少了这层推断会直接报错。

两个踩过的坑，都写进了单测：

1. **指标不支持 `like`**。聚合结果是数值，模糊匹配没有语义，让它走到 ClickHouse 只会得到
   `Illegal types ... of arguments` 这种看不懂的报错，所以在组装阶段就拒绝，并提示可用操作符。
2. **`HAVING` 里要用别名**。当指标 key 与聚合表达式里的列名同名时（例如 `click -> sum(clicks)`，
   别名也叫 `click`），ClickHouse 会把 SELECT 的别名带进 HAVING，`sum(clicks)` 会被解析成
   `sum(sum(clicks))`，报 *Aggregate function is found inside another aggregate function*。
   所以指标若同时被选中，`HAVING` 引用别名；没被选中（SELECT 里没有别名可用）才写原始表达式。

**中文含义（label_map）**：`label_map` 的 key 对应 `dim_map` / `mtx_map` 的键，value 是中文名。
查询页的勾选控件会显示「消耗（cost）」这种形式，结果表头直接显示中文，
原始字段名收进 Tooltip（鼠标悬停可见）——既照顾业务用户，又不丢字段名这个对接信息。
没有配中文名的字段自动退回显示 key，不会显示空表头。

**精度**：ClickHouse 的 `Decimal` 落到 `float64` 会丢精度（金额场景致命），所以这类值一律以字符串返回。

**排错**：用户看不到 SQL，出错时前端展示引擎原始错误 + `request_id`，完整 SQL 只进服务日志——
拿 request_id 去日志里捞即可。

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
| POST | `/query/execute` | 按查询意图执行查询，返回列、行、耗时、是否截断 |
| GET | `/datasources/:key/dim-values` | 某维度的候选值（`?field=city`），上限 `QUERY_DIM_VALUE_LIMIT` |
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
| `CH_HOST` / `CH_PORT` | clickhouse / 9000 | ClickHouse 地址（native 协议），**必须是只读账号** |
| `MYSQL_IMAGE` / `CH_IMAGE` | mysql:8.0 / clickhouse-server:24.8 | 镜像名覆盖，写在 `.env` 里（用于配置镜像加速源） |
| `CH_USER` / `CH_PASSWORD` / `CH_DB` | default / 空 / default | ClickHouse 凭据 |
| `QUERY_TIMEOUT_SECONDS` | 30 | 查询超时（同时作用于 context 与 CH 的 max_execution_time） |
| `QUERY_MAX_ROWS` | 10000 | 单次结果硬顶 |
| `QUERY_DEFAULT_LIMIT` | 1000 | 未指定 limit 时的默认行数 |
| `QUERY_MAX_CONCURRENCY` | 8 | 同时执行的查询数上限 |
| `QUERY_DIM_VALUE_LIMIT` | 1000 | 维度候选值上限 |
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

## 类型映射（已在真实 ClickHouse 上验证）

| ClickHouse 类型 | 返回给前端 | 说明 |
| --- | --- | --- |
| `String` / `UInt64` | 字符串 / 数字 | 原样 |
| `Decimal` | **字符串** | 直接落 `float64` 会丢精度，金额场景致命 |
| `Date` | `2026-10-05` | 不带时分秒，避免变成 `T00:00:00Z` |
| `DateTime` | RFC3339 字符串 | |
| `Nullable(T)` 为 NULL | `null` | 前端渲染成灰色 NULL |

驱动要点：`clickhouse-go` **不支持扫描到 `*interface{}`**，必须按 `ColumnTypes()[i].ScanType()`
构造目标；`Nullable` 列要给**二级指针**，否则 NULL 会被读成零值，和空字符串分不开。

## 已知边界

- `mid_sql` 不做任何校验，写错的 SQL 要等下游执行时才暴露。列表页会截断展示 SQL，方便肉眼扫一遍。
- 系统不接鉴权，操作人来自请求头 `X-User`（前端右上角填写，存 localStorage），
  仅用于审计字段 `created_by` / `updated_by`。如需接入 SSO，在 `middleware.Operator` 处替换即可。
- 没有变更历史表。如需回滚能力，加一张 `datasource_config_history` 在 service 的写路径上插快照即可。
