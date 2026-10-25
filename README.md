# dataset_service

dataset 配置的增删改查服务。一条配置包含五个字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `dataset_key` | varchar(64) | 业务主键，全局唯一，强制小写 |
| `dataset_name` | varchar(128) | 展示名 |
| `mid_sql` | mediumtext | 中间层 SQL，**纯文本存储，不做语法/语义校验** |
| `dim_map` | json | 维度映射，`map[string]string` |
| `mtx_map` | json | 指标映射，`map[string]string` |
| `label_map` | json | 维度/指标的中文含义，`map[string]string`，**只影响展示**，不参与 SQL 生成。它是**覆盖层**：留空则继承全局字典（见下节） |

另有一张全局字典表 `tb_global_label`（`field_key` → `label`），对所有数据集生效。

技术栈：Go 1.26 + gin + GORM + MySQL 8.0 / React 18 + TypeScript + Vite + Ant Design 5 + Monaco / Docker Compose。

## 快速开始

```bash
docker compose up -d --build   # 构建并启动 app + mysql
open http://localhost:8080
```

MySQL 首次启动会自动执行 `deploy/mysql/init.sql` 建库建表，数据落在 named volume `mysql-data`。

### 拉不到镜像时怎么办

`docker.io` 在部分网络下直接返回 **Bad Gateway**，表现为 `FROM xxx` 就解析失败：

```
failed to solve: golang:1.26-alpine: failed to resolve source metadata for
docker.io/library/golang:1.26-alpine: ... Bad Gateway
```

Dockerfile 的三个基础镜像与两个包管理源都做成了 `ARG`，**默认值已经指向加速源**
（`docker.1ms.run` + `goproxy.cn` + `npmmirror`），一般直接构建即可。要换源时改两处：

```bash
# 1) Dockerfile 顶部的 ARG 默认值
# 2) docker-compose.yml 的 build.args（它的 :- 兜底会覆盖 Dockerfile 的值，两处必须一致）
```

也可以只在 `.env` 里覆盖，不必改文件（`.env` 已在 `.gitignore`）：

```bash
NODE_IMAGE=docker.m.daocloud.io/library/node:22-alpine
GO_IMAGE=docker.m.daocloud.io/library/golang:1.26-alpine
RUNTIME_IMAGE=docker.m.daocloud.io/library/alpine:3.21
```

> **踩过的坑**：只在 Dockerfile 里改默认值没用。`build.args` 里 `${NODE_IMAGE:-node:22-alpine}`
> 的兜底值会传进去把默认覆盖掉，于是仍然去解析 docker.io。**两处默认值必须一起改。**

宿主端口如果被占（本机装了 MySQL 会占 3306），改 `docker-compose.yml` 的 `ports`，
或先停掉本机服务：`brew services stop mysql`。

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
| **自带 Web 控制台**（推荐先用这个） | http://localhost:8123/play | ClickHouse 内置，零额外组件。登录用 `reader` / `reader_pass`（只读）或 `dataset` / `ch_pass` |
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

## 三个页面

| 路由 | 功能 |
| --- | --- |
| `/datasets` | 配置管理：dataset 的增删改查 |
| `/labels` | 字段名称：全局「字段名 → 中文名」字典，对所有数据集生效 |
| `/query` | 可视化查询：选数据集 → 选维度/指标 → 加过滤 → 查数 → 看表格和图表 |

## 字段名称：全局字典 + 数据集覆盖

同一个 `city` 原本要在每个数据集里重复写一遍「城市」。现在抽了一层全局字典，
数据集侧的 `label_map` 退化成覆盖层：

```
最终展示名 = 数据集 label_map[k]  →  全局 tb_global_label[k]  →  字段名 k
             （优先级高）                                        （优先级低）
```

**三态语义**（这是唯一容易踩空的地方）：

| 数据集 `label_map` 的状态 | 结果 |
| --- | --- |
| 没有这个 key | 继承全局定义 |
| `label_map[k]` 非空 | 覆盖，只作用于当前数据集 |
| `label_map[k]` 为 `""`（显式空串） | **不继承**全局，退回显示字段名本身 |

第三种是给「本数据集的同名字段与全局语义不同、又不想另起名字」准备的。
数据集编辑页的 `label_map` 表格会多一列「来源」，把「覆盖 / 与全局一致 / 不继承 / 自定义」
直接标出来，并在表单项下方列出「继承全局：city → 城市 …」，避免改了全局之后静默变错。

**合并发生在服务端**（`query.Service.VisibleDatasets`），前端拿到的 `label_map` 就是最终值，
所以查询页下拉、结果表头、图表轴与图例三处消费点都不需要知道全局字典的存在。

几个实现取舍：

- **只对真实存在的列生成名字**：以 `dim_map` / `mtx_map`（且通过列级权限过滤后）为准，
  不是以 `label_map` 或全局字典为准。否则全局字典里跟本数据集无关的字段会混进表头。
- **停用 = 不存在**：全局定义可以停用，停用后引用它的数据集退回显示字段名。
- **进程内缓存 30 秒**：字典会被每个数据集、每次查询读到，不缓存等于每次列表都打一遍全表。
  写操作会立即失效本进程缓存；多实例部署时其他实例靠 TTL 兜底——纯展示字段晚几秒无所谓。
- **读失败绝不阻断查询**：字典取不到时降级为空字典（显示字段名），甚至沿用上一次的缓存，
  不把错误抛给查询主流程。为了显示中文名而让整个查询失败是本末倒置。
- **`field_key` 不可改**：改名等价于「删一条 + 建一条」，原地改会让引用它的数据集在
  不知情的情况下换名字。

存量环境升级：

```bash
mysql < deploy/mysql/migrate_add_global_label.sql
```

脚本会建表、把「多个数据集都有且中文名一致」的公共字段（`city` / `cost` / `channel` /
`date` / `uv`）提到全局，**并把这些 key 从各数据集的 `label_map` 里摘掉**——不摘的话
覆盖层会永远压着全局，改全局看不出效果。

## 租户与权限管控（数据集级 / 列级 / 行级）

**登录态**：顶栏可填多个登录身份，存在浏览器本地，随请求头带给后端
——和「操作人」走 `X-User` 是同一套极简模式，系统不接鉴权：

| 顶栏 | 请求头 | 用途 |
| --- | --- | --- |
| 登录态租户 | `X-Tenants: t1,t2` | 数据集级 / 列级白名单命中判断；行级 `tenant` 规则的取值 |
| 可见用户 | `X-Visible-Users: u1,u2` | 行级 `user` 规则的取值（一个用户可以代看若干用户的数据） |

**数据集侧**：配置表新增 JSON 列 `acl`，三级管控，**在配置页以纯 JSON 编辑**
（`row_filter` 另有开关控件，控件改动会同步写回这段 JSON）：

```jsonc
{
  "tenants": ["t1", "t2"],                                    // 数据集级：有交集才可见
  "col_tenants": {"stat_date": ["t1"], "cost": ["t1", "t2"]}, // 列级：没配的列默认可见
  "row_filter": {                                             // 行级：追加到 WHERE
    "tenant": {"enabled": true, "column": "tenant"},
    "user":   {"enabled": true, "column": "owner"}
  }
}
```

- `tenants`：数据集级。空 / 不填 = 不限制。
- `col_tenants`：列级。key 是 `dim_map` / `mtx_map` 的**键**（即查询页里看到的维度/指标名），
  没配的列默认可见，配了的列有交集才可见。
- `row_filter`：行级。两条规则各自独立开关，`enabled` 为真时把「登录态取值」以
  `列名 IN (...)` 的形式**追加到 WHERE 顶层**（与用户自己填的条件是 AND 关系，服务端注入，前端传参绕不过）。

用 JSON **对象**而不是纯数组，是为了后续扩展：再加 `roles` / 读写分离时往对象里加字段即可，
不必改表结构、不必迁存量数据。

**行级过滤的三个约束**：

1. `column` 只能取 `dim_map` 的键。行级过滤发生在**聚合前**，而 `mtx_map` 是
   `sum(...)` / `uniq(...)` 这类聚合结果，放进 WHERE 会被 ClickHouse 直接拒绝。
   服务层校验不通过即 400。
2. 登录态对应列表为空时按 **fail-closed** 处理：该数据集查不到任何行，
   而不是「放行全量」——权限配置宁可查不出，也不能多给。
3. 两条规则都关闭时 `row_filter` 会被整体摘掉，不会在 JSON 里留空壳。

列名拼错会让那一列**静默保持可见**——权限配置 fail-open 比报错更危险，
所以服务层会校验 `col_tenants` 的每个 key 必须属于 `dim_map` / `mtx_map`，
`row_filter` 的 `column` 必须属于 `dim_map`，否则 400 并列出允许的列名。

**管控范围**：按当前约定只管控**查询页**。

| 接口 | 行为 |
| --- | --- |
| `GET /api/v1/query/datasets` | 已按数据集级过滤；`dim_map` / `mtx_map` 再按列级过滤，`label_map` 为「全局字典 + 数据集覆盖」合并后、且只含可见列的结果。不含 `mid_sql` 与 `acl` |
| `POST /api/v1/query/execute` | 数据集或列无权访问 → 403，并记 WARN 日志；行级过滤以 AND 追加到 WHERE |
| `GET /api/v1/datasets/:key/dim-values` | 同上，维度候选值同样受行级过滤约束 |
| 配置管理页的列表/详情/改删 | **不受影响**，所有数据集都可见可改 |

`execute` 除了校验 `dims` / `metrics`，还会**遍历过滤条件树里的所有字段**——
过滤条件可以引用没被选为维度的列，这是最容易漏掉的一条路径。

可见性规则就一处实现：`model.ACL.Allows`。刻意没把它写进 SQL——后续维度变多时，
规则集中放在 Go 里才不会出现 SQL 与 Go 各写一遍、两边不一致的情况。
代价是配置表要保持在千行量级，对「数据集配置」完全够用。

## 可视化查询怎么工作

用户不接触 SQL，只描述「想看什么」：

```jsonc
// POST /api/v1/query/execute
{
  "dataset_key": "order_daily",
  "dims":    ["date", "city"],        // 必须是该数据集 dim_map 里的 key
  "metrics": ["cost", "click"],       // 必须是该数据集 mtx_map 里的 key
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

### mid_sql 模板：按查询裁剪 JOIN

`mid_sql` 支持 **Go text/template**。典型用途：一次查询用不到某张维表的字段时，
整个 `LEFT JOIN` 就不必丢给 ClickHouse。

> 实测（1000 万行事实表 × 1000 行维表）：只查消耗时，裁掉用不到的 LEFT JOIN
> 耗时从 31ms 降到 11ms。**收益在 CPU 不在 IO** —— JOIN 的代价是每行探测一次 hash，
> 读取行数几乎不变。维表越大、事实表行数越多，收益越大。
> （反过来，把 WHERE 条件下推进 `mid_sql` 是**没有收益**的：ClickHouse 优化器自己就会做，
> 实测读取行数一模一样。）

可用变量：

| 变量 | 内容 |
| --- | --- |
| `.Dims` / `.Metrics` | 选中的维度名 / 指标名，保持选择顺序 |
| `.Fields` | 本次用到的全部字段（维度 + 指标 + 过滤字段 + 行级权限列），去重排序 |
| `.Filters` | 过滤条件引用到的字段，去重排序 |

判断方法（`{{ if .HasAny "a" "b" }} ... {{ end }}`）：

| 方法 | 含义 |
| --- | --- |
| `.Has "a"` | 用到某个字段 |
| `.HasAny "a" "b"` | 用到其中任意一个（不传参数 = false，保守不裁剪） |
| `.HasAll "a" "b"` | 全部都用到（不传参数 = true） |
| `.HasDim` / `.HasMetric` | 只在维度 / 指标范围内判断 |

也提供等价的函数形式 `hasAny . "a"` 或 `hasAny .Fields "a"`；模板内置的
`and` / `or` / `not` 可直接用来组合条件。

示例（三张维表，各自的保留条件不同）：

```sql
select
  f.stat_date as stat_date,
  f.stat_cost as stat_cost
  {{ if .HasAny "city_name" "city_tier" }}
  , c.city_name as city_name, c.city_tier as city_tier
  {{ end }}
  {{ if .Has "shop_name" }}
  , s.shop_name as shop_name
  {{ end }}
from demo.t_order_dtl f
{{ if .HasAny "city_name" "city_tier" }}
  left join dim_city c on f.city_code = c.city_code
{{ end }}
{{ if .HasAll "brand_name" "shop_name" }}
  -- 品牌维表借道店铺维表，两个都在时才 join
  left join dim_brand b on s.brand_id = b.brand_id
{{ end }}
```

**安全与正确性**：

1. 模板能引用到的只有 `dim_map` / `mtx_map` 的键（已过白名单校验）；过滤的取值
   一律走参数绑定，永远不进模板文本。所以模板只能改变标识符与 SQL 片段。
2. **裁掉 JOIN 的正确性由配置者声明**。系统无法校验「关联键在右表是否唯一」——
   不唯一时 LEFT JOIN 会放大行数，裁掉后 `sum` 会偏小；INNER JOIN 更危险（它本身在过滤行）。
3. 不含 `{{` 的配置按纯 SQL 处理，零开销，存量配置行为不变。
4. 渲染失败一律返回 400 并带上原因，**不回退**到不裁剪的写法——悄悄换 SQL 会让口径变化。
5. 渲染结果有 1 MiB 上限（防 `range` 写错撑爆），模板解析结果按内容哈希缓存（上限 256 条）。
6. 行级权限用到的列也参与 `.Fields`，否则模板可能裁掉权限条件依赖的 JOIN。

### 结果区：表格与图表

结果区四个 tab —— **表格（默认）/ 柱状图 / 折线图 / 饼图**，共用同一份返回结果，图表侧全部是前端加工，不再请求后端：

- **字段完全跟着查询走**：结果区不提供二次圈选控件。第 1 个维度做 X 轴、第 2 个维度做分组、
  勾选的指标全部画成系列（`日期 × 城市` 一次画完）。想换口径回查询构建器改，避免同一份数据
  出现两套互相打架的字段选择。系列数超过 12 条时按总量取前 12 并提示。
- **智能推荐**：按「维度数 × 指标数、X 轴是否为时间、类目多少、指标之间的量级差」在对应 tab 上打
  **「推荐」**角标，并在 tab 上方写一句理由（例如「1 个维度 × 2 个指标，2 个指标量级相差约 2501 倍，
  图上小的会被压平，看表格更准」）。**只标记、不自动切换**——用户停在自己的 tab 上不会被抢走焦点。
  规则在 `web/src/utils/chartRecommend.ts`，纯前端推导，后端接口不变。
- **不可用的图直接置灰**：饼图需要「单个指标、不分组、类目 3~12 个」，折线图至少需要一个维度；
  不满足时 tab 置灰，悬停给出具体原因，而不是点进去看到一张莫名其妙的图。
- **NULL 不是 0**：指标为 NULL 时折线断开、柱不画；维度为 NULL 显示为「(空值)」类目。
  早期版本把 `NaN` 兜成 0，看消耗类指标时会把「没数据」读成「数据为 0」。
- **精度**：Decimal 在后端转成字符串保精度，画图时才转 number；
  tooltip 显示的是**原始字符串**，与表格里的值一致，Y 轴刻度才用「万 / 亿」紧凑格式。
- **饼图看占比**：悬停显示「数值（占比 x%）」，占比由前端按该指标的总量现算——
  饼图的存在意义就是占比，光给绝对值等于让人自己在脑子里除一遍。总量为 0 时退回只显示数值。
- **导出**：CSV 与 PNG 都在浏览器里做（CSV 带 BOM，Excel 打开中文不乱码），后端不提供导出接口。

> 图表类型刻意只保留三种。条形图/面积图本质上就是柱状图的排版差异、双 Y 轴则是「量级差太大」
> 这一种特例——这三种情况都改成推荐**表格**（看数比看图准）或柱状图，少一层「选哪个」的负担。
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
| GET | `/datasets` | 分页列表，参数 `page` `size` `keyword` `status` |
| GET | `/datasets/:key` | 详情 |
| POST | `/datasets` | 新建，key 冲突返回 409 |
| PUT | `/datasets/:key` | 全量更新，带 `version` 乐观锁，冲突返回 409 |
| DELETE | `/datasets/:key` | 软删除 |
| POST | `/datasets/validate` | 只校验 dim_map / mtx_map，不落库 |
| GET | `/labels` | 全局字段名称列表，参数 `page` `size` `keyword` `status` |
| GET | `/labels/:field_key` | 单条全局定义 |
| POST | `/labels` | 新建，`field_key` 冲突返回 409 |
| PUT | `/labels/:field_key` | 更新中文名与启停，带 `version` 乐观锁；`field_key` 不可改 |
| DELETE | `/labels/:field_key` | 软删除 |
| GET | `/label-map` | 全量字典 `{field_key: 中文名}`，供编辑页显示继承提示（不分页） |
| POST | `/query/execute` | 按查询意图执行查询，返回列、行、耗时、是否截断 |
| GET | `/datasets/:key/dim-values` | 某维度的候选值（`?field=city`），上限 `QUERY_DIM_VALUE_LIMIT` |
| GET | `/healthz` `/readyz` | 存活 / 就绪探针（readyz 会 ping 数据库） |

除 `Content-Type` 外，请求头还有三个：`X-User`（审计）、`X-Tenants`、`X-Visible-Users`（登录态身份）。

示例：

```bash
curl -X POST localhost:8080/api/v1/datasets \
  -H 'Content-Type: application/json' -H 'X-User: zhangsan' \
  -d '{
    "dataset_key": "order_daily",
    "dataset_name": "订单日报",
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
| `DB_USER` / `DB_PASSWORD` / `DB_NAME` | dataset / - / dataset_service | 数据库凭据 |
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
   `uk_dataset_key(dataset_key, deleted_at)`，才能真正约束住，同时允许删了再建同名 key。

3. **`dataset_key` 强制小写**。MySQL 默认 collation `utf8mb4_0900_ai_ci` 不区分大小写，
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
- 登录态租户 / 可见用户同样来自请求头（`X-Tenants` / `X-Visible-Users`），客户端传什么就按什么过滤。
  **真实环境必须由网关注入或覆盖这两个头**，否则调用方可以自己给自己提权。
  HTTP 头只能带 ASCII，所以租户 id 与用户 id 请保持 ASCII（中文值请走编码或用 ASCII 别名）。
- 全局字典的 `field_key` 强制小写，但数据集的 `dim_map` / `mtx_map` 的键目前**没有**强制小写。
  如果你在 `dim_map` 里写了 `Cost`，全局定义的 `cost` 不会生效，而且不会有任何报错——
  表头静默显示 `Cost`。同名不同义的排查也依赖人工，冲突检测视图还没做。
- 字段名称页的「引用数据集」列只扫描前 200 个数据集，是个量级参考，不是精确统计。
- 没有变更历史表。如需回滚能力，加一张 `tb_dataset_config_history` 在 service 的写路径上插快照即可。
