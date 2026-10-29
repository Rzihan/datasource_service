-- ClickHouse 初始化脚本：容器首次启动时由 /docker-entrypoint-initdb.d 自动执行。
-- 用途：给可视化查询页提供一份可查的演示数据，并创建一个只读账号。

CREATE DATABASE IF NOT EXISTS demo;

-- 订单明细宽表：覆盖查询页会遇到的各种类型
CREATE TABLE IF NOT EXISTS demo.t_order_dtl
(
    stat_date Date,                 -- 日期维度
    city_code String,               -- 字符串维度
    channel   Nullable(String),     -- 可空维度，用于验证 NULL 的渲染
    stat_cost Decimal(18, 2),       -- 金额，验证 Decimal 不被 float64 吃掉精度
    clicks    UInt64,
    uid       String,
    -- 多值维度：一个人同时属于多个公司 / 一个订单打了多个标签。
    -- 这类字段不能放进 GROUP BY（会按公司拆成多行），展示上要收拢成一个值。
    companies Array(String)
)
ENGINE = MergeTree
ORDER BY (stat_date, city_code);

-- 5000 行演示数据。金额刻意构造成 n + 0.15，
-- 一旦代码某处把它转成了 float64，聚合结果的小数位就会变成 .149999 之类。
INSERT INTO demo.t_order_dtl
SELECT
    toDate('2026-10-01') + toInt32(number % 20)                        AS stat_date,
    ['北京', '上海', '广州', '深圳', '杭州'][toInt32(number % 5) + 1]    AS city_code,
    if(number % 7 = 0, NULL, ['app', 'web', 'mini'][toInt32(number % 3) + 1]) AS channel,
    -- 除以 100 得到带两位小数的金额（n + 0.15），用 Decimal 而非 Float 存储
    toDecimal64((number % 5000) * 100 + 15, 2) / 100                    AS stat_cost,
    toUInt64(rand() % 5000 + 1)                                        AS clicks,
    concat('u', toString(number % 2000))                               AS uid,
    -- 每行 1~3 个公司，刻意让「同一个 uid 有多行、公司之间有重叠」，
    -- 才能验证收拢（groupUniqArrayArray）而不是展开（arrayJoin）
    arrayFilter(
        x -> x != '',
        arrayDistinct(
            array(
                ['公司A', '公司B', '公司C'][toInt32(number % 3) + 1],
                if(number % 4 = 0, '公司B', ''),
                if(number % 5 = 0, '公司C', '')
            )
        )
    )                                                                  AS companies
FROM numbers(5000);

-- 只读账号：查询服务用它连接，避免有人误写或拖库
CREATE USER IF NOT EXISTS reader IDENTIFIED WITH plaintext_password BY 'reader_pass';
GRANT SELECT ON demo.* TO reader;

-- 演示用的 dataset 配置也可以直接写 MySQL，但那属于另一个库，
-- 这里只管 ClickHouse 侧的表和数据。
