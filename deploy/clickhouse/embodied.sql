-- =============================================================================
-- 具身智能机器人「数据采集—标注—质检—交付」全链路演示数据
-- =============================================================================
--
-- 业务背景：公司为具身智能模型厂商生产训练数据（真机操作示教 → 人工标注 →
--           抽检质检 → 按项目交付结算）。看板的四类使用者分别是数采员、
--           标注员、质检员、商务，他们看的是同一条流水线的不同环节。
--
-- 建模原则（和这张表配套的 5 个数据集配置是一套东西，要一起改）：
--   1. 事实表里只放 ID 和可度量的数值，中文名一律由 dim_* 提供。
--      名字会变（团队改名、机型升级），ID 不会；把文本塞进事实表，
--      历史数据和新数据早晚对不上。
--   2. 名字的翻译放在数据集 mid_sql 里 JOIN 维度表，而不是前端再翻一层。
--      口径只有一份，换数据集、换看板都不会拿到两套解释。
--
-- 时间范围：近 30 天，2026-10-01 ~ 2026-10-30。
-- 数据量级：约 165 万行明细（数采 48 万 / 标注 90 万 / 质检 26 万 / 交付 1.2 万）。
--
-- 数据形态是刻意做出来的，不是 rand() 撒出来的：
--   · 产能靠人排班堆出来，周末自然回落；月初爬产，月末冲当月目标；
--   · 10-16 ~ 10-18 设备返厂，产能和有效率同步下滑；
--   · 晚班、难场景、新手、返厂机型的有效率更低。
--     没有这些差异，看板只能「看」，分析不出「为什么」。
--
-- 用法：本文件作为第二个初始化脚本挂进 docker-entrypoint-initdb.d。
-- 文件名要排在 init.sql 之前（e < i），这样 init.sql 里给只读账号 reader
-- 授权时这个库已经存在。
-- =============================================================================

CREATE DATABASE IF NOT EXISTS embodied;

-- ---------------------------------------------------------------------------
-- 一、维度表
-- ---------------------------------------------------------------------------

-- 人员。四类角色共用一张表：数采员 / 标注员 / 质检员 / 商务。
-- 共用而不是各建一张，是因为「归属团队、入职时间」对所有角色都要用，
-- 分开维护必然出现两边不一致。
CREATE TABLE IF NOT EXISTS embodied.dim_staff
(
    staff_id   UInt32,
    staff_no   String,
    staff_name String,
    role       LowCardinality(String),
    team       LowCardinality(String),
    city       LowCardinality(String),
    level      LowCardinality(String),
    entry_date Date
)
ENGINE = MergeTree ORDER BY staff_id;

-- 机器人本体（数采用的设备）。机型与厂商是有效率的一段底噪：
-- 老机型腕部抖动更多，这是后面看板里能查出来的结论。
CREATE TABLE IF NOT EXISTS embodied.dim_robot
(
    robot_id      UInt32,
    robot_sn      String,
    model         LowCardinality(String),
    vendor        LowCardinality(String),
    firmware      LowCardinality(String),
    site          LowCardinality(String),
    purchase_date Date,
    status        LowCardinality(String)
)
ENGINE = MergeTree ORDER BY robot_id;

-- 任务场景（操作任务本体）。difficulty 同时决定采集时长、标注工时与通过率，
-- unit_price 决定商务侧这条数据卖多少钱。
CREATE TABLE IF NOT EXISTS embodied.dim_scene
(
    scene_id   UInt32,
    scene_name String,
    category   LowCardinality(String),
    difficulty LowCardinality(String),
    unit_price Decimal64(2)
)
ENGINE = MergeTree ORDER BY scene_id;

-- 客户。交付事实表只存 customer_id，其余全部从这里 JOIN 出来。
CREATE TABLE IF NOT EXISTS embodied.dim_customer
(
    customer_id       UInt32,
    customer_name     String,
    industry          LowCardinality(String),
    region            LowCardinality(String),
    tier              LowCardinality(String),
    bd_id             UInt32,
    pay_term_days     UInt16,
    cooperation_start Date
)
ENGINE = MergeTree ORDER BY customer_id;


-- ---------------------------------------------------------------------------
-- 二、事实表
-- ---------------------------------------------------------------------------

-- 采集明细：一行 = 一名数采员操作一台机器人完成的一次完整操作片段（episode）。
-- valid = 0 表示判废，reject_reason 说明废在哪——这是数采团队复盘的直接依据。
CREATE TABLE IF NOT EXISTS embodied.fact_collection_episode
(
    stat_date     Date,
    episode_id    String,
    collector_id  UInt32,
    robot_id      UInt32,
    scene_id      UInt32,
    batch_no      String,
    shift         LowCardinality(String),
    start_hour    UInt8,
    modality      LowCardinality(String),
    duration_sec  UInt32,
    frames        UInt32,
    traj_points   UInt32,
    storage_gb    Decimal64(2),
    quality_score Float32,
    valid         UInt8,
    reject_reason LowCardinality(String)
)
ENGINE = MergeTree PARTITION BY toYYYYMM(stat_date)
ORDER BY (stat_date, scene_id, collector_id);

-- 标注明细：一行 = 一名标注员交付的一个标注任务单元。
-- skill_tags 是多值维度：一个单元会同时涉及多个技能标签。放进 GROUP BY 会按标签
-- 拆成多行，那回答的是「标了几个技能」，而不是业务要看的「这单标了什么」。
CREATE TABLE IF NOT EXISTS embodied.fact_annotation_unit
(
    stat_date      Date,
    task_id        String,
    annotator_id   UInt32,
    scene_id       UInt32,
    anno_type      LowCardinality(String),
    difficulty     LowCardinality(String),
    tool_version   LowCardinality(String),
    shift          LowCardinality(String),
    unit_count     UInt32,
    frame_count    UInt32,
    duration_sec   UInt32,
    rework_count   UInt8,
    first_pass     UInt8,
    accuracy_score Float32,
    skill_tags     Array(String)
)
ENGINE = MergeTree PARTITION BY toYYYYMM(stat_date)
ORDER BY (stat_date, anno_type, annotator_id);

-- 质检明细：一行 = 一次抽检判定。stage 区分抽检的是采集数据还是标注结果，
-- 缺陷字典按 stage 分开给——两类环节的缺陷本来就不是一回事。
CREATE TABLE IF NOT EXISTS embodied.fact_qc_sample
(
    stat_date    Date,
    check_id     String,
    checker_id   UInt32,
    stage        LowCardinality(String),
    batch_no     String,
    scene_id     UInt32,
    defect_type  LowCardinality(String),
    severity     LowCardinality(String),
    verdict      LowCardinality(String),
    sample_count UInt16,
    defect_count UInt16,
    repair_sec   UInt32
)
ENGINE = MergeTree PARTITION BY toYYYYMM(stat_date)
ORDER BY (stat_date, stage, checker_id);

-- 交付 / 结算明细：一行 = 一个项目在某天的交付批次。
-- 应收开票、回款、欠款都在这一层，并且互相对得上账：arrears = receivable - received。
CREATE TABLE IF NOT EXISTS embodied.fact_delivery_daily
(
    stat_date         Date,
    customer_id       UInt32,
    project_id        String,
    project_name      String,
    bd_id             UInt32,
    scene_id          UInt32,
    phase             LowCardinality(String),
    delivered_units   UInt32,
    delivered_frames  UInt64,
    unit_price        Decimal64(2),
    revenue           Decimal64(2),
    contract_amount   Decimal64(2),
    receivable        Decimal64(2),
    received          Decimal64(2),
    arrears           Decimal64(2),
    gross_margin_rate Float32,
    satisfaction      Float32,
    pay_term_days     UInt16
)
ENGINE = MergeTree PARTITION BY toYYYYMM(stat_date)
ORDER BY (stat_date, customer_id);


-- ---------------------------------------------------------------------------
-- 三、维度数据
-- ---------------------------------------------------------------------------

TRUNCATE TABLE IF EXISTS embodied.dim_staff;

INSERT INTO embodied.dim_staff
WITH ['王', '李', '张', '刘', '陈', '杨', '赵', '黄', '周', '吴',
      '徐', '孙', '马', '朱', '胡', '林', '郭', '何', '高', '罗'] AS SUR,
     ['伟', '芳', '娜', '敏', '静', '磊', '洋', '艳', '勇', '强',
      '军', '杰', '涛', '明', '超', '燕', '丽', '霞', '平', '刚'] AS GIV,
     ['上海张江', '深圳南山', '北京亦庄', '苏州工业园', '杭州未来科技城', '成都高新'] AS SITES
SELECT
    toUInt32(number + 1) AS staff_id,
    concat('E', leftPad(toString(staff_id), 4, '0')) AS staff_no,
    -- 姓与名取两次哈希的不同位：直接 intDiv(number, 20) 会让前 20 人全叫「X伟」
    concat(SUR[toInt32(cityHash64(toUInt64(staff_id)) % 20) + 1],
           GIV[toInt32(intDiv(cityHash64(toUInt64(staff_id)), 20) % 20) + 1]) AS staff_name,
    multiIf(number < 120, '数采员', number < 380, '标注员', number < 420, '质检员', '商务') AS role,
    multiIf(
        number < 120,
        concat('采集', ['一', '二', '三', '四', '五', '六'][toInt32(intDiv(number, 20)) + 1], '组'),
        number < 380,
        concat('标注', ['一', '二', '三', '四', '五', '六', '七', '八'][least(toInt32(8), toInt32(intDiv(number - 120, 33)) + 1)], '组'),
        number < 420,
        concat('质检', ['一', '二'][toInt32(intDiv(number - 380, 20)) + 1], '组'),
        concat(['华东', '华北', '华南'][toInt32(intDiv(number - 420, 6)) + 1], '大区')
    ) AS team,
    SITES[toInt32(number % 6) + 1] AS city,
    -- 每 4 人里 1 个新人。事实表里的损耗算法用同一条规则，否则「新手更容易废片」
    -- 这个结论在数据库里对不上，看板就查不出来。
    multiIf(staff_id % 4 = 1, '初级', staff_id % 4 = 0, '高级', '中级') AS level,
    multiIf(
        level = '初级', toDate('2026-09-10') + toInt32(staff_id % 40),
        level = '中级', toDate('2025-03-01') + toInt32(staff_id % 400),
        toDate('2023-06-01') + toInt32(staff_id % 500)
    ) AS entry_date
FROM numbers(438);


TRUNCATE TABLE IF EXISTS embodied.dim_robot;

INSERT INTO embodied.dim_robot
WITH ['GR-1 双臂', 'GR-1S 双臂', 'SR-3 单臂', 'W2 轮式底盘', 'DH-5 灵巧手台'] AS MODELS,
     ['自研产线', '华毂本体', '同川协作', '砺行关节'] AS VENDORS,
     ['v3.2.1', 'v3.3.0', 'v3.4.2', 'v4.0.0-rc1'] AS FW,
     ['上海张江', '深圳南山', '北京亦庄', '苏州工业园', '杭州未来科技城', '成都高新'] AS SITES
SELECT
    toUInt32(number + 1) AS robot_id,
    concat('RB-', leftPad(toString(robot_id), 3, '0')) AS robot_sn,
    MODELS[toInt32(number % 5) + 1] AS model,
    VENDORS[toInt32(intDiv(number, 5) % 4) + 1] AS vendor,
    FW[toInt32(number % 4) + 1] AS firmware,
    SITES[toInt32(number % 6) + 1] AS site,
    toDate('2024-05-01') + toInt32(number * 17) AS purchase_date,
    -- 3 台在故障窗口内返厂维修：和下面日期权重里的 outage 一起构成
    -- 「设备侧拖累产能」这条可查的线索
    if(robot_id IN (7, 19, 33), '返厂维修', '在役') AS status
FROM numbers(40);


TRUNCATE TABLE IF EXISTS embodied.dim_scene;

INSERT INTO embodied.dim_scene
WITH ['叠衣服', '衣物分类', '抓取放置', '倒水入杯', '开抽屉取物', '冰箱取物',
      '微波炉操作', '插拔充电枪', '擦桌子', '桌面收纳', '双臂协同搬运', '开门通过',
      '按钮按压', '柔性体折叠', '工具使用', '码垛堆叠'] AS NAMES,
     ['家务操作', '家务操作', '基础抓取', '柔性液体', '家居交互', '家居交互',
      '家电操作', '插接操作', '清洁整理', '整理归纳', '双臂协同', '移动导航',
      '基础按压', '柔性物体', '工具操作', '双臂协同'] AS CATS,
     ['中', '中', '易', '难', '中', '中', '难', '难', '易', '中', '难', '中',
      '易', '难', '难', '中'] AS DIFF
SELECT
    toUInt32(number + 1) AS scene_id,
    NAMES[toInt32(number) + 1] AS scene_name,
    CATS[toInt32(number) + 1] AS category,
    DIFF[toInt32(number) + 1] AS difficulty,
    -- 单价（元/条）按难度拉开：难场景采集慢、标注贵，交付报价本来就更高。
    -- 这里的 28 / 52 / 96 会被交付事实表原样引用，改一处要跟着改另一处。
    toDecimal64(multiIf(DIFF[toInt32(number) + 1] = '易', 28.0, DIFF[toInt32(number) + 1] = '中', 52.0, 96.0), 2) AS unit_price
FROM numbers(16);


TRUNCATE TABLE IF EXISTS embodied.dim_customer;

-- 24 家客户，每 2 家由一个商务负责。bd_id 的分配规则必须与交付事实表一致，
-- 否则同一个商务的盘子两边算出来不一样。
INSERT INTO embodied.dim_customer
WITH ['启元智能', '博衍机器人', '云枢科技', '星核动力', '弈行智能', '擎羿动力',
      '衡石智造', '拾象能动', '弥优机器人', '行知仿生', '鼎翌智能', '穹顶感知',
      '流深科技', '砺行机器人', '元枢仿生', '衡岳智行', '钧远智能', '兰穹动力',
      '同尘机器人', '析木自控', '南栖智能', '岚启具身', '曜石科技', '沐辰机器人'] AS NAMES,
     ['具身算法', '硬件本体', '算法平台', '整机厂商', '算法平台', '硬件本体',
      '智能制造', '仿真平台', '硬件本体', '科研院所', '算法平台', '感知方案',
      '数据服务', '硬件本体', '科研院所', '自动驾驶', '家电制造', '硬件本体',
      '算法平台', '工业自动化', '算法平台', '具身算法', '感知方案', '家电制造'] AS INDS,
     ['华东', '华北', '华南', '华东', '西南', '华东', '华南', '华北', '华东', '西南',
      '华北', '华东', '华南', '华东', '华北', '华南', '华东', '西南', '华东', '华北',
      '华南', '华东', '华北', '西南'] AS REGS
SELECT
    toUInt32(number + 1) AS customer_id,
    NAMES[toInt32(number) + 1] AS customer_name,
    INDS[toInt32(number) + 1] AS industry,
    REGS[toInt32(number) + 1] AS region,
    multiIf(number % 5 = 0, '战略客户', number % 5 IN (1, 2), '重点客户', '一般客户') AS tier,
    toUInt32(421 + intDiv(number, 2)) AS bd_id,
    -- 账期：战略客户谈到 30 天，一般客户多数 60 天。回款分析要的就是这个差异
    multiIf(tier = '战略客户', 30, tier = '重点客户', 45, 60) AS pay_term_days,
    toDate('2025-07-01') + toInt32(number * 23) AS cooperation_start
FROM numbers(24);
-- ---------------------------------------------------------------------------
-- 四、采集事实数据（48 万 Episode）
-- ---------------------------------------------------------------------------
--
-- 日期不是均匀分布：周日和周一的产能不一样。做法是先给每天一个权重
-- （周末系数 × 爬产系数 × 故障窗口 × 月末冲刺），再按累计分布抽样，
-- 这样每个日期的期望行数正比于当天目标产量。
--
-- 这一层数据要能支撑出四条具体结论：
--   1. 周末产能回落（排班制，周末约六成）
--   2. 10-16 ~ 10-18 设备返厂，产能与有效率同步下滑
--   3. 晚班有效率明显低于早班（现场光照与人员状态）
--   4. 采集四组整体偏慢、废片偏多（团队差异）
--      —— 这些都不是 rand() 撒出来的均匀数据会有的东西。
--
-- WITH 里的行级变量统一加 v_ 前缀：它们不能和最终 SELECT 的输出别名重名，
-- 否则 ClickHouse 报 MULTIPLE_EXPRESSIONS_FOR_ALIAS。

TRUNCATE TABLE IF EXISTS embodied.fact_collection_episode;

INSERT INTO embodied.fact_collection_episode
WITH toDate('2026-10-01') AS START_DAY,
     range(30) AS IDXS,
     arrayMap(i -> if(toDayOfWeek(START_DAY + toInt32(i)) IN (6, 7), 0.60, 1.0), IDXS) AS W_WEEKEND,
     arrayMap(i -> if(i < 5, 0.62 + toFloat64(i) * 0.09, 1.0), IDXS) AS W_RAMP,
     arrayMap(i -> 0.86 + toFloat64(i) * 0.006, IDXS) AS W_TREND,
     arrayMap(i -> if(i BETWEEN 15 AND 17, 0.66, 1.0), IDXS) AS W_OUTAGE,
     arrayMap(i -> if(i >= 26, 1.14, 1.0), IDXS) AS W_PUSH,
     arrayMap(i -> W_WEEKEND[toInt32(i) + 1] * W_RAMP[toInt32(i) + 1] * W_TREND[toInt32(i) + 1]
                   * W_OUTAGE[toInt32(i) + 1] * W_PUSH[toInt32(i) + 1], IDXS) AS W_DAY,
     arrayCumSum(W_DAY) AS CUM,
     CUM[length(CUM)] AS TOTAL,
     -- 同一行要用到多个相互独立的随机数：种子链式哈希，而不是 rand()。
     -- rand() 每次跑都不一样，出了问题没法复现，也没法写进回归断言。
     cityHash64(toUInt64(number), 11) AS h0,
     cityHash64(h0, 12) AS h1,
     cityHash64(h0, 13) AS h2,
     cityHash64(h0, 14) AS h3,
     cityHash64(h0, 15) AS h4,
     START_DAY + toInt32(arrayFirstIndex(x -> x >= toFloat64(h0 % 1000000) / 1000000.0 * TOTAL, CUM)) - 1 AS stat_date,
     toInt32(h1 % 120) + 1 AS v_cid,
     toInt32(intDiv(h1, 120) % 6) + 1 AS v_team_no,
     toInt32(intDiv(h1, 720) % 16) + 1 AS v_sid,
     toInt32(intDiv(h1, 11520) % 40) + 1 AS v_rid,
     toInt32(intDiv(h1, 460800) % 3) AS v_shift_no,
     ['早班', '中班', '晚班'][v_shift_no + 1] AS v_shift,
     toUInt8((8 + v_shift_no * 8 + toInt32(intDiv(h2, 1000) % 7)) % 24) AS v_hour,
     multiIf(v_cid % 4 = 1, 1, 0) AS v_new_hire,
     -- 难度决定单次操作的基准时长；这里的序列必须和 dim_scene 保持一致
     [2, 2, 1, 3, 2, 2, 3, 3, 1, 2, 3, 2, 1, 3, 3, 2][v_sid] AS v_diff,
     -- 团队效率：快慢体现在完成一次操作的耗时上（熟练的人动作更利落）
     [1.00, 0.95, 1.02, 1.15, 0.92, 1.06][v_team_no] AS v_pace,
     [0.000, 0.015, -0.005, -0.035, 0.010, -0.020][v_team_no] AS v_quality_adj,
     greatest(20.0, [75, 165, 330][v_diff] * (0.55 + toFloat64(h2 % 900) / 1000.0) * v_pace) AS v_dur,
     round(v_dur) * (24 + intDiv(h2, 1000000) % 8) AS v_frames,
     arrayCumSum([34, 26, 22, 18]) AS W_MODALITY,
     arrayFirstIndex(x -> x >= toFloat64(intDiv(h2, 100000000) % 100), W_MODALITY) AS v_modality_no,
     ['RGB-D', '力觉+RGB-D', '触觉+RGB-D', '全景+力觉'][v_modality_no] AS v_modality,
     -- 每帧压缩后的体积（MB），不是原始点云那个量级：RGB-D 单帧压缩后约 25KB，
     -- 叠加力觉 / 触觉 / 全景通道会更大。按未压缩体积算会得出一个月 7 PB，
     -- 单集体积和汇总量就都不可信了。
     [0.025, 0.038, 0.052, 0.070][v_modality_no] AS v_frame_mb,
     -- 有效率：基准 96.5%，按「晚班 / 难度 / 返厂机型 / 新人 / 故障窗口」逐项扣
     greatest(0.55, least(0.995, 0.965
         - multiIf(v_shift_no = 2, 0.050, v_shift_no = 1, 0.012, 0.0)
         - multiIf(v_diff = 3, 0.035, v_diff = 2, 0.012, 0.0)
         - if(v_rid IN (7, 19, 33), 0.100, 0.0)
         - if(v_new_hire = 1, 0.035, 0.0)
         - if(stat_date BETWEEN toDate('2026-10-16') AND toDate('2026-10-18'), 0.045, 0.0)
         + v_quality_adj)) AS v_p_valid,
     toUInt8(toFloat64(h3 % 1000) < v_p_valid * 1000.0) AS v_valid,
     arrayCumSum([24, 21, 15, 14, 10, 8, 8]) AS W_REJECT,
     ['镜头遮挡', '任务未完成', '数据截断', '轨迹抖动', '光照不达标', '设备掉线', '未脱敏'][
         arrayFirstIndex(x -> x >= toFloat64(intDiv(h4, 1000) % 100), W_REJECT)] AS v_reject
SELECT
    stat_date,
    concat('EP-', replaceAll(toString(stat_date), '-', ''), '-', leftPad(toString(number), 7, '0')) AS episode_id,
    toUInt32(v_cid) AS collector_id,
    toUInt32(v_rid) AS robot_id,
    toUInt32(v_sid) AS scene_id,
    concat('COL-', replaceAll(toString(stat_date), '-', ''), '-',
           ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'][v_team_no],
           leftPad(toString(1 + toInt32(intDiv(h4, 100000) % 40)), 2, '0')) AS batch_no,
    v_shift AS shift,
    v_hour AS start_hour,
    v_modality AS modality,
    toUInt32(round(v_dur)) AS duration_sec,
    toUInt32(v_frames) AS frames,
    toUInt32(toFloat64(v_frames) / 2.5) AS traj_points,
    toDecimal64(toFloat64(v_frames) * v_frame_mb / 1024.0, 2) AS storage_gb,
    round(greatest(55.0, least(99.5, 100.0 - (1.0 - v_p_valid) * 160.0
          + toFloat64(intDiv(h4, 10000000) % 1200) / 100.0 - 6.0)), 2) AS quality_score,
    v_valid AS valid,
    if(v_valid = 1, '', v_reject) AS reject_reason
FROM numbers(480000);
-- ---------------------------------------------------------------------------
-- 五、标注事实数据（90 万标注任务单元）
-- ---------------------------------------------------------------------------
--
-- 标注量要和人数对得起：260 名标注员 × 30 天 × 7.5 小时 ≈ 5.85 万工时，
-- 90 万单元摊下来每单元平均 4 分钟左右、每人每天 115 单——这是能站住的口径。
-- 反过来算：如果每单元随便给个 20 分钟，总工时就会超过 20 万小时，
-- 看板上「人均产出」这类指标立刻假得没法看。
--
-- 这一层要支撑的结论：
--   1. 3D 点云 / 动作轨迹的一次通过率明显低于 2D 框（越难的类型越容易返修）
--   2. 月末冲刺期一次通过率下滑（赶工）
--   3. 新工具 v3.0.0-beta 反而不如 v2.5.2（新版本有学习成本）
--   4. 标注七组整体质量更好、产能更高

TRUNCATE TABLE IF EXISTS embodied.fact_annotation_unit;

INSERT INTO embodied.fact_annotation_unit
WITH toDate('2026-10-01') AS START_DAY,
     range(30) AS IDXS,
     -- 标注是室内工作，周末降幅比采集小；月初同样在爬产，月末跟着采集一起冲量
     arrayMap(i -> if(toDayOfWeek(START_DAY + toInt32(i)) IN (6, 7), 0.78, 1.0), IDXS) AS W_WEEKEND,
     arrayMap(i -> if(i < 4, 0.70 + toFloat64(i) * 0.10, 1.0), IDXS) AS W_RAMP,
     arrayMap(i -> 0.88 + toFloat64(i) * 0.005, IDXS) AS W_TREND,
     arrayMap(i -> if(i >= 26, 1.16, 1.0), IDXS) AS W_PUSH,
     arrayMap(i -> W_WEEKEND[toInt32(i) + 1] * W_RAMP[toInt32(i) + 1] * W_TREND[toInt32(i) + 1]
                   * W_PUSH[toInt32(i) + 1], IDXS) AS W_DAY,
     arrayCumSum(W_DAY) AS CUM,
     CUM[length(CUM)] AS TOTAL,
     cityHash64(toUInt64(number), 21) AS h0,
     cityHash64(h0, 22) AS h1,
     cityHash64(h0, 23) AS h2,
     cityHash64(h0, 24) AS h3,
     cityHash64(h0, 25) AS h4,
     START_DAY + toInt32(arrayFirstIndex(x -> x >= toFloat64(h0 % 1000000) / 1000000.0 * TOTAL, CUM)) - 1 AS stat_date,
     -- 标注员是 dim_staff 里的 121 ~ 380
     toInt32(h1 % 260) + 121 AS v_aid,
     least(toInt32(8), toInt32(intDiv(v_aid - 121, 33)) + 1) AS v_team_no,
     toInt32(intDiv(h1, 260) % 16) + 1 AS v_sid,
     [2, 2, 1, 3, 2, 2, 3, 3, 1, 2, 3, 2, 1, 3, 3, 2][v_sid] AS v_diff_no,
     ['易', '中', '难'][v_diff_no] AS v_difficulty,
     arrayCumSum([28, 24, 16, 12, 13, 7]) AS W_TYPE,
     arrayFirstIndex(x -> x >= toFloat64(h1 % 100), W_TYPE) AS v_type_no,
     ['2D框', '语义分割', '关键点', '3D点云', '动作轨迹', '语言指令'][v_type_no] AS v_anno_type,
     arrayCumSum([46, 38, 16]) AS W_SHIFT,
     arrayFirstIndex(x -> x >= toFloat64(intDiv(h1, 100) % 100), W_SHIFT) AS v_shift_no,
     ['早班', '中班', '晚班'][v_shift_no] AS v_shift,
     arrayCumSum([18, 34, 30, 18]) AS W_TOOL,
     arrayFirstIndex(x -> x >= toFloat64(intDiv(h1, 10000) % 100), W_TOOL) AS v_tool_no,
     ['v2.4.1', 'v2.5.0', 'v2.5.2', 'v3.0.0-beta'][v_tool_no] AS v_tool,
     -- 单个任务单元的标注对象数，按类型给基准，再乘难度系数
     [180, 55, 120, 40, 18, 45][v_type_no] * (0.55 + toFloat64(h2 % 900) / 1000.0)
         * multiIf(v_diff_no = 3, 1.40, v_diff_no = 2, 1.00, 0.75) AS v_unit_f,
     greatest(1.0, v_unit_f) AS v_units,
     -- 每单元的折算帧数：点云/轨迹类是逐帧作业，框类基本一个对象一帧
     [1, 6, 1, 10, 25, 1][v_type_no] * v_units AS v_frames,
     -- 单件工时（秒）按类型给，经验排序：分割 > 点云 > 轨迹 > 关键点 > 语言 > 2D框
     [1.2, 4.5, 1.8, 7.0, 11.0, 2.6][v_type_no] * v_units
         * multiIf(v_diff_no = 3, 1.25, v_diff_no = 2, 1.00, 0.80)
         * [1.02, 1.00, 0.98, 1.06, 0.94, 1.03, 0.96, 1.01][v_team_no] AS v_sec_f,
     multiIf(v_aid % 4 = 1, 1, 0) AS v_new_hire,
     greatest(0.55, least(0.995, 0.935
         - multiIf(v_type_no = 4, 0.045, v_type_no = 5, 0.035, v_type_no = 2, 0.015, 0.0)
         - multiIf(v_diff_no = 3, 0.030, v_diff_no = 2, 0.010, 0.0)
         - if(v_new_hire = 1, 0.040, 0.0)
         - if(v_shift_no = 3, 0.010, 0.0)
         - if(stat_date >= toDate('2026-10-26'), 0.025, 0.0)
         + [0.000, 0.005, 0.015, -0.020][v_tool_no]
         + [0.008, -0.012, 0.015, -0.020, 0.005, -0.008, 0.010, -0.005][v_team_no])) AS v_p_pass,
     toUInt8(toFloat64(h3 % 1000) < v_p_pass * 1000.0) AS v_first_pass,
     ['抓取', '放置', '姿态估计', '力控', '避障', '仿人操作', '双臂协同', '语言理解', '移动导航'] AS TAGS
SELECT
    stat_date,
    concat('AN-', replaceAll(toString(stat_date), '-', ''), '-', leftPad(toString(number), 7, '0')) AS task_id,
    toUInt32(v_aid) AS annotator_id,
    toUInt32(v_sid) AS scene_id,
    v_anno_type AS anno_type,
    v_difficulty AS difficulty,
    v_tool AS tool_version,
    v_shift AS shift,
    toUInt32(round(v_units)) AS unit_count,
    toUInt32(round(v_frames)) AS frame_count,
    toUInt32(greatest(20.0, v_sec_f)) AS duration_sec,
    if(v_first_pass = 1, 0, toUInt8(1 + toInt32(intDiv(h4, 100) % 3))) AS rework_count,
    v_first_pass AS first_pass,
    round(greatest(60.0, least(99.8, 100.0 - (1.0 - v_p_pass) * 120.0
        + toFloat64(intDiv(h4, 10000) % 900) / 100.0 - 4.5)), 2) AS accuracy_score,
    -- 多值维度：一个任务单元同时涉及多个技能标签，这里必须留成 Array，
    -- 展开成多行会把「这单标了什么」变成「标了几个技能」
    arraySort(arrayDistinct(arrayFilter(
        x -> x != '',
        [TAGS[toInt32(intDiv(h2, 1000) % 9) + 1],
         TAGS[toInt32(intDiv(h2, 10000) % 9) + 1],
         if(intDiv(h2, 100000) % 100 < 45, TAGS[toInt32(intDiv(h2, 1000000) % 9) + 1], '')]
    ))) AS skill_tags
FROM numbers(900000);
-- ---------------------------------------------------------------------------
-- 六、质检事实数据（6 万次抽检）
-- ---------------------------------------------------------------------------
--
-- 抽检量必须和上游产出对得上：采集 48 万 + 标注 90 万 ≈ 138 万条，
-- 按 10% 左右的抽检比例，一个月约 15 万个抽检样本。
-- 一行 = 一次抽检判定（同批次一次抽 sample_count 个），6 万行 × 均值 2.6 ≈ 15.6 万，
-- 这个数量级下「抽检覆盖率」这类指标才有意义；抽得比产出还多显然是说不通的。
--
-- 这一层要支撑的结论：
--   1. 标注环节的通过率低于采集环节（人工作业更容易出错）
--   2. 10-16 ~ 10-18 采集侧通过率同步下滑（设备问题的下游反应）
--   3. 缺陷集中在少数几类——TOP 缺陷就是下一轮培训的重点

TRUNCATE TABLE IF EXISTS embodied.fact_qc_sample;

INSERT INTO embodied.fact_qc_sample
WITH toDate('2026-10-01') AS START_DAY,
     range(30) AS IDXS,
     arrayMap(i -> if(toDayOfWeek(START_DAY + toInt32(i)) IN (6, 7), 0.55, 1.0), IDXS) AS W_WEEKEND,
     arrayMap(i -> if(i < 5, 0.72 + toFloat64(i) * 0.06, 1.0), IDXS) AS W_RAMP,
     arrayMap(i -> 0.90 + toFloat64(i) * 0.004, IDXS) AS W_TREND,
     -- 月末下游集中出货，抽检跟着放量
     arrayMap(i -> if(i >= 26, 1.22, 1.0), IDXS) AS W_PUSH,
     arrayMap(i -> W_WEEKEND[toInt32(i) + 1] * W_RAMP[toInt32(i) + 1] * W_TREND[toInt32(i) + 1]
                   * W_PUSH[toInt32(i) + 1], IDXS) AS W_DAY,
     arrayCumSum(W_DAY) AS CUM,
     CUM[length(CUM)] AS TOTAL,
     cityHash64(toUInt64(number), 31) AS h0,
     cityHash64(h0, 32) AS h1,
     cityHash64(h0, 33) AS h2,
     cityHash64(h0, 34) AS h3,
     START_DAY + toInt32(arrayFirstIndex(x -> x >= toFloat64(h0 % 1000000) / 1000000.0 * TOTAL, CUM)) - 1 AS stat_date,
     -- 质检员是 dim_staff 里的 381 ~ 420
     toInt32(h1 % 40) + 381 AS v_cid,
     multiIf(v_cid % 4 = 1, 1, 0) AS v_new_hire,
     toInt32(intDiv(h1, 40) % 16) + 1 AS v_sid,
     [2, 2, 1, 3, 2, 2, 3, 3, 1, 2, 3, 2, 1, 3, 3, 2][v_sid] AS v_diff_no,
     arrayCumSum([42, 58]) AS W_STAGE,
     arrayFirstIndex(x -> x >= toFloat64(intDiv(h1, 640) % 100), W_STAGE) AS v_stage_no,
     ['采集', '标注'][v_stage_no] AS v_stage,
     -- 一次抽检覆盖的样本数：小批次为主
     toUInt16(1 + intDiv(h2, 100) % 5) AS v_samples,
     greatest(0.60, least(0.995, multiIf(v_stage_no = 1, 0.912, 0.898)
         - multiIf(v_diff_no = 3, 0.030, v_diff_no = 2, 0.012, 0.0)
         - if(v_stage_no = 1 AND stat_date BETWEEN toDate('2026-10-16') AND toDate('2026-10-18'), 0.060, 0.0)
         - if(stat_date >= toDate('2026-10-26'), 0.025, 0.0)
         - if(v_new_hire = 1, 0.020, 0.0))) AS v_p_pass,
     toUInt8(toFloat64(h3 % 1000) < v_p_pass * 1000.0) AS v_pass,
     -- 判定：不通过里约 8 成返修、2 成报废
     multiIf(v_pass = 1, '通过', intDiv(h3, 1000) % 10 < 8, '返修', '报废') AS v_verdict,
     arrayCumSum([26, 20, 18, 22, 14]) AS W_DEF_C,
     arrayCumSum([27, 24, 17, 14, 12, 6]) AS W_DEF_A,
     arrayCumSum([55, 33, 12]) AS W_SEV
SELECT
    stat_date,
    concat('QC-', replaceAll(toString(stat_date), '-', ''), '-', leftPad(toString(number), 6, '0')) AS check_id,
    toUInt32(v_cid) AS checker_id,
    v_stage AS stage,
    concat(['COL', 'ANN'][v_stage_no], '-', replaceAll(toString(stat_date), '-', ''), '-',
           leftPad(toString(1 + toInt32(intDiv(h2, 100000) % 60)), 2, '0')) AS batch_no,
    toUInt32(v_sid) AS scene_id,
    if(v_pass = 1, '无缺陷',
       multiIf(v_stage_no = 1,
               ['画面遮挡', '轨迹抖动', '数据截断', '任务未完成', '光照不达标'][
                   arrayFirstIndex(x -> x >= toFloat64(intDiv(h2, 100) % 100), W_DEF_C)],
               ['漏标', '错标', '框偏移', '轨迹断点', '标签不一致', '未脱敏'][
                   arrayFirstIndex(x -> x >= toFloat64(intDiv(h2, 100) % 100), W_DEF_A)])) AS defect_type,
    if(v_pass = 1, '无',
       ['轻微', '一般', '严重'][
           arrayFirstIndex(x -> x >= toFloat64(intDiv(h3, 10000) % 100), W_SEV)]) AS severity,
    v_verdict AS verdict,
    v_samples AS sample_count,
    if(v_pass = 1, toUInt16(0), toUInt16(1 + intDiv(h2, 1000000) % least(4, v_samples))) AS defect_count,
    if(v_verdict = '返修', toUInt32(300 + intDiv(h3, 100000) % 2100), toUInt32(0)) AS repair_sec
FROM numbers(60000);
-- ---------------------------------------------------------------------------
-- 七、交付 / 结算事实数据（1 万行）
-- ---------------------------------------------------------------------------
--
-- 商务这一层最容易拍脑袋编，所以数量对齐是硬约束：
--   · 当月有效采集约 43 万条，交付 34 万条左右 —— 有积压、有分批，但不至于
--     「卖出去的比采回来的还多」；
--   · revenue = delivered_units × unit_price，unit_price 来自 dim_scene 的报价
--     再乘客户分层的折扣；
--   · arrears = receivable - received，回款进度按「开票后经过天数 / 账期」推进，
--     所以月末欠得多、月初的单子基本结清——账龄分析就是看这个。
--
-- 这一层要支撑的结论：
--   1. 欠款集中在一般客户（账期长、催款难）
--   2. 量产交付阶段毛利最高（规模效应），POC 阶段毛利被前期成本吃掉
--   3. 月末集中交付，回款滞后导致应收余额走高

TRUNCATE TABLE IF EXISTS embodied.fact_delivery_daily;

INSERT INTO embodied.fact_delivery_daily
WITH toDate('2026-10-01') AS START_DAY,
     toDate('2026-10-30') AS TODAY,
     range(30) AS IDXS,
     -- 结算与开票都走工作日，周末几乎不落单
     arrayMap(i -> if(toDayOfWeek(START_DAY + toInt32(i)) IN (6, 7), 0.35, 1.0), IDXS) AS W_WEEKEND,
     arrayMap(i -> 0.80 + toFloat64(i) * 0.010, IDXS) AS W_TREND,
     arrayMap(i -> if(i >= 26, 1.45, 1.0), IDXS) AS W_PUSH,
     arrayMap(i -> W_WEEKEND[toInt32(i) + 1] * W_TREND[toInt32(i) + 1] * W_PUSH[toInt32(i) + 1], IDXS) AS W_DAY,
     arrayCumSum(W_DAY) AS CUM,
     CUM[length(CUM)] AS TOTAL,
     cityHash64(toUInt64(number), 41) AS h0,
     cityHash64(h0, 42) AS h1,
     cityHash64(h0, 43) AS h2,
     cityHash64(h0, 44) AS h3,
     cityHash64(h0, 45) AS h4,
     arrayFirstIndex(x -> x >= toFloat64(h0 % 1000000) / 1000000.0 * TOTAL, CUM) AS v_day_idx,
     START_DAY + toInt32(v_day_idx) - 1 AS stat_date,
     toInt32(h1 % 24) + 1 AS v_cid,
     (v_cid - 1) % 5 AS v_mod5,
     multiIf(v_mod5 = 0, '战略客户', v_mod5 IN (1, 2), '重点客户', '一般客户') AS v_tier,
     -- bd 的分配规则必须和 dim_customer 完全一致（两家一个商务）
     toUInt32(421 + intDiv(v_cid - 1, 2)) AS v_bd,
     1 + toInt32(intDiv(h1, 24) % (1 + v_cid % 3)) AS v_proj_seq,
     toInt32(intDiv(h1, 240) % 16) + 1 AS v_sid,
     [2, 2, 1, 3, 2, 2, 3, 3, 1, 2, 3, 2, 1, 3, 3, 2][v_sid] AS v_diff_no,
     -- 项目阶段随交付推进向后演进，各项目用序号错开起点
     least(toInt32(4), 1 + toInt32(intDiv(toInt32(v_day_idx) - 1 + v_proj_seq * 7, 8))) AS v_phase_no,
     ['POC', '小批量', '量产交付', '验收'][v_phase_no] AS v_phase,
     [0.92, 0.96, 1.00][multiIf(v_tier = '战略客户', 1, v_tier = '重点客户', 2, 3)] AS v_tier_factor,
     toInt32(greatest(1.0, round([8, 25, 70, 18][v_phase_no]
         * (0.55 + toFloat64(h2 % 900) / 1000.0)
         * multiIf(v_diff_no = 3, 0.80, v_diff_no = 2, 1.00, 1.35)))) AS v_units,
     [28.0, 52.0, 96.0][v_diff_no] * v_tier_factor AS v_price,
     toFloat64(v_units) * v_price AS v_revenue_f,
     multiIf(v_tier = '战略客户', 15, v_tier = '重点客户', 30, 45) AS v_pay_term,
     toInt32(TODAY - stat_date) AS v_elapsed,
     toFloat64(v_elapsed) / v_pay_term AS v_progress,
     -- 回款 = 预付款 + 进度款 + 到期结算。三段都不能少：
     -- 只 modeled 到期一次付清的话，30 天窗口里账期内的单子一分钱回不来，
     -- 回款率会低到没有业务含义；真实合同是签约预付、节点付款、月结尾款。
     multiIf(v_tier = '战略客户', 0.30, v_tier = '重点客户', 0.20, 0.10) AS v_prepay,
     multiIf(v_tier = '战略客户', 0.95, v_tier = '重点客户', 0.86, 0.70) AS v_settle,
     least(1.0, greatest(0.0, multiIf(
         v_progress >= 1.0, v_settle + toFloat64(intDiv(h3, 100) % 100) / 100.0 * 0.03,
         v_progress >= 0.6, v_prepay + (v_settle - v_prepay) * 0.55,
         v_progress >= 0.3, v_prepay + (v_settle - v_prepay) * 0.25,
         v_prepay * 0.8))) AS v_pay_ratio,
     round(v_revenue_f * v_pay_ratio, 2) AS v_received_f,
     [0.22, 0.28, 0.36, 0.40][v_phase_no]
         - multiIf(v_tier = '战略客户', 0.030, v_tier = '重点客户', 0.012, 0.0)
         + toFloat64(intDiv(h4, 100) % 1000) / 10000.0 - 0.05 AS v_margin
SELECT
    stat_date,
    toUInt32(v_cid) AS customer_id,
    concat('PRJ-', leftPad(toString(v_cid), 2, '0'), '-', toString(v_proj_seq)) AS project_id,
    concat(['双臂操作', '家务泛化', '移动导航', '柔性物体'][1 + (v_cid % 4)], '数据集 V',
           toString(1 + v_proj_seq)) AS project_name,
    v_bd AS bd_id,
    toUInt32(v_sid) AS scene_id,
    v_phase AS phase,
    toUInt32(v_units) AS delivered_units,
    toUInt64(v_units * (3000 + intDiv(h2, 1000) % 3000)) AS delivered_frames,
    toDecimal64(v_price, 2) AS unit_price,
    toDecimal64(v_revenue_f, 2) AS revenue,
    -- 只有少数行是当日新签 / 增补，其余为 0：合同额是流量指标，不能天天有
    toDecimal64(if(intDiv(h4, 10000) % 100 < 4,
                   round(v_revenue_f * (2.0 + toFloat64(intDiv(h4, 1000000) % 60) / 10.0), 2), 0.0), 2) AS contract_amount,
    toDecimal64(v_revenue_f, 2) AS receivable,
    toDecimal64(v_received_f, 2) AS received,
    toDecimal64(round(v_revenue_f - v_received_f, 2), 2) AS arrears,
    round(greatest(0.05, v_margin), 4) AS gross_margin_rate,
    round(greatest(1.0, least(5.0, 4.75
        - multiIf(v_diff_no = 3, 0.35, v_diff_no = 2, 0.15, 0.0)
        - multiIf(v_tier = '战略客户', 0.10, v_tier = '重点客户', 0.05, 0.0)
        + toFloat64(intDiv(h4, 10000000) % 600) / 1000.0 - 0.3)), 2) AS satisfaction,
    toUInt16(v_pay_term) AS pay_term_days
FROM numbers(10000);
