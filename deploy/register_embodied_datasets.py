#!/usr/bin/env python3
"""注册「具身智能机器人数据平台」的全局字段名与 5 个数据集。

为什么要写成脚本而不是手工在页面上点：
数据集配置等同于生产元数据，页面上点出来的结果别人复制不出来，也进不了版本库。
这套数据是给数采 / 标注 / 质检 / 商务四类角色看的，任何一次口径变动都应该可追溯。

用法（后端在本地 8080）：
    python3 deploy/register_embodied_datasets.py
    python3 deploy/register_embodied_datasets.py --base http://localhost:8080 --dry-run

--dry-run 只做配置自检（拿真实数仓跑一遍才知道通不通），不落库。
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request

BASE = "http://localhost:8080"
OPERATOR = "example@example.com"

# ---------------------------------------------------------------------------
# 全局字段名：字段名 → 中文名。
# 跨数据集共用的字典，落在这一层的好处是改一次所有数据集都生效；
# 数据集自己的 label_map 退化为「这里确实要叫别的名字」时才用。
# ---------------------------------------------------------------------------
GLOBAL_LABELS = {
    # 注意：字典的 key 是 dim_map / mtx_map 的**键名**，不是 SQL 里的列名。
    # 设成列名（collector_name）的话，查询页按键名 collector 查不到中文，
    # 下拉里就会直接露出英文键名。
    "stat_date": "日期",
    "collector": "数采员",
    "annotator": "标注员",
    "checker": "质检员",
    "bd": "商务负责人",
    "staff": "员工",
    "team": "所属团队",
    "level": "职级",
    "city": "城市",
    "scene": "任务场景",
    "category": "场景类别",
    "difficulty": "难度",
    "robot_model": "机型",
    "vendor": "本体厂商",
    "firmware": "固件版本",
    "shift": "班次",
    "modality": "采集模态",
    "batch_no": "批次号",
    "valid": "是否有效",
    "reject_reason": "判废原因",
    "anno_type": "标注类型",
    "tool_version": "工具版本",
    "first_pass": "一次通过",
    "skill_tags": "涉及技能",
    "stage": "环节",
    "defect_type": "缺陷类型",
    "severity": "严重等级",
    "verdict": "判定",
    "customer": "客户",
    "industry": "客户行业",
    "region": "客户区域",
    "tier": "客户分层",
    "phase": "项目阶段",
    "project_id": "项目编号",
    "project_name": "项目名称",
    "pay_term_days": "账期(天)",
    # 指标
    "episodes": "采集条数",
    "valid_episodes": "有效条数",
    "total_hours": "采集工时(h)",
    "valid_hours": "有效工时(h)",
    "frames": "帧数",
    "valid_frames": "有效帧数",
    "storage_gb": "存储量(GB)",
    "avg_duration": "平均时长(秒)",
    "avg_quality": "平均质量分",
    "valid_rate": "有效率(%)",
    "collectors": "数采员数",
    "per_person": "人均产出",
    "tasks": "任务数",
    "units": "标注对象数",
    "work_hours": "标注工时(h)",
    "rework": "返修次数",
    "pass_tasks": "一次通过数",
    "pass_rate": "通过率(%)",
    "avg_accuracy": "平均准确率",
    "annotators": "标注员数",
    "checks": "抽检批次",
    "samples": "抽检样本数",
    "defects": "缺陷数",
    "pass_samples": "合格样本数",
    "repair_hours": "返修工时(h)",
    "scrap": "报废数",
    "checkers": "质检员数",
    "customers": "客户数",
    "projects": "项目数",
    "units_delivered": "交付条数",
    "delivered_frames": "交付帧数",
    "revenue": "交付收入(元)",
    "contract": "新签合同额(元)",
    "receivable": "应收金额(元)",
    "received": "已回款(元)",
    "arrears": "欠款余额(元)",
    "payment_rate": "回款率(%)",
    "avg_price": "单价(元/条)",
    "avg_term": "平均账期(天)",
    "satisfaction": "客户满意度",
    "bds": "商务人数",
    "staff_cnt": "在岗人数",
    "output_units": "产出单元",
    "gross_margin": "毛利率(%)",
}


# ---------------------------------------------------------------------------
# 数据集说明书（meta）。
#
# 数据集交给别人用之后，被问得最多的不是「怎么查」，而是三个问题：
#   这个数是什么口径？多久更新一次？出问题找谁？
# 以前靠嘴传，现在写进 meta，查询页会显示在字段下拉和结果区顶部。
#
# field_notes 的 key 必须是 dim_map / mtx_map 的键名；
# examples 里的 query 就是查询页地址栏里 ds 之后的那一段，
# 直接照着一张搭好的图复制 URL 尾部即可，不用另写一套结构。
# ---------------------------------------------------------------------------
META = {
    "robot_collection": {
        "description": "数采环节逐条采集明细：谁、在哪、用什么机器人、采了多少、废了多少。适合看产能、有效率、设备和场景分布。",
        "owner": "数采运营 · 王工",
        "update_freq": "每日 06:00 增量（T+1）",
        "tags": ["数采", "产能", "设备"],
        "field_notes": {
            "episodes": "采集条数，含被判废的条数；按条统计，不是按帧",
            "valid_episodes": "通过质检的有效条数 = episodes - 废片",
            "valid_rate": "有效条数 / 采集条数（%）。分母用条数不是工时，所以不能和产能直接比较",
            "storage_gb": "按 RGB-D 约 25KB/帧估算的压缩后大小，不是磁盘实测值",
            "total_hours": "采集工时（小时），已按班次折算",
            "per_person": "人均日产出 = 采集条数 / 在岗人数",
            "avg_duration": "单条平均时长（秒）",
            "avg_quality": "单条质量分均值，0~100，低于 70 会被判废",
            "reject_reason": "判废原因；有效条为空",
        },
        "examples": [
            {
                "title": "每日采集量与有效率",
                "note": "看整体节拍和周末峰谷；有效率掉到 88% 以下要查判废原因",
                "query": "dims=date&metrics=episodes,valid_rate&limit=1000",
            },
            {
                "title": "各任务场景产出对比",
                "note": "16 个场景的产出分布，找出产能洼地",
                "query": "dims=scene&metrics=episodes,valid_rate,avg_quality&limit=1000",
            },
            {
                "title": "团队产能榜",
                "note": "按团队看人均产出，用于排班与激励",
                "query": "dims=team,collector&metrics=episodes,per_person&limit=200",
            },
            {
                "title": "采集量周环比",
                "note": "预置里也能带对比周期：直接给出「比上周同一天涨了多少」",
                "query": "dims=date&metrics=episodes&cmp=prev_period&cmpf=date&limit=1000",
            },
        ],
    },
    "robot_annotation": {
        "description": "标注环节逐单元产出明细：标注类型、标注员、一次通过率、返工与工时。适合看产能、质量与人员能力。",
        "owner": "标注中心 · 李工",
        "update_freq": "每日 07:00（T+1）",
        "tags": ["标注", "质量", "产能"],
        "field_notes": {
            "units": "标注对象数（框 / 点 / 轨迹段），不是任务数——同一个任务里可能有几十个对象",
            "pass_rate": "一次通过率（%）= 首次验收通过单元 / 提交单元；返工后的二次通过不计入",
            "first_pass": "是否一次通过；用它筛出返工部分单独看",
            "rework": "返工单元数，返工不减少 units，会增加 work_hours",
            "work_hours": "标注工时（小时）",
            "per_person": "人均日产出（标注对象数）",
            "skill_tags": "多值维度：一个标注员可能同时具备多个技能标签，收拢展示",
            "avg_accuracy": "抽检准确率均值（%），与 pass_rate 口径不同：后者是验收，前者是抽检",
        },
        "examples": [
            {
                "title": "各标注类型产能与通过率",
                "note": "3D 框通常慢于 2D 框，通过率也低，排期要按类型分开估",
                "query": "dims=anno_type&metrics=units,pass_rate,work_hours&limit=1000",
            },
            {
                "title": "人员产能榜（近 7 天）",
                "note": "人均产出前 20，用于排班",
                "query": "dims=annotator&metrics=units,per_person,pass_rate&limit=20",
            },
        ],
    },
    "robot_qc": {
        "description": "质检抽检明细：抽了多少、发现多少缺陷、判废多少、返修工时。适合看质量水位与缺陷分布。",
        "owner": "质量部 · 张工",
        "update_freq": "每日 08:00（T+1）",
        "tags": ["质检", "质量"],
        "field_notes": {
            "samples": "抽检样本数；抽样比例约为上游产出的 13%",
            "pass_samples": "抽检通过的样本数",
            "pass_rate": "抽检通过率（%）= pass_samples / samples。样本是抽的，不是全检，不能当成整体合格率",
            "defects": "发现的缺陷条数；一次抽检可能发现多个缺陷",
            "scrap": "判废条数，会回写到数采 / 标注环节",
            "repair_hours": "返修工时（小时）",
            "stage": "被抽检的环节（数采 / 标注），看缺陷分布时先按环节过滤",
        },
        "examples": [
            {
                "title": "各环节抽检通过率趋势",
                "note": "按日期看质量水位；标注环节通常低于数采",
                "query": "dims=date,stage&metrics=samples,pass_rate&limit=1000",
            },
            {
                "title": "标注环节缺陷 TOP",
                "note": "只在标注环节里看缺陷类型分布，避免和数采的字典混在一起",
                "query": "dims=defect_type&metrics=defects&filter=%7B%22logic%22%3A%22and%22%2C%22children%22%3A%5B%7B%22field%22%3A%22stage%22%2C%22op%22%3A%22%3D%22%2C%22value%22%3A%22%E6%A0%87%E6%B3%A8%22%7D%5D%7D&limit=20",
            },
        ],
    },
    "robot_business": {
        "description": "商务环节项目级明细：合同、交付、收入、回款与账期。适合看客户结构、回款风险与毛利。",
        "owner": "商务 · 陈经理",
        "update_freq": "每日 09:00（T+1）",
        "tags": ["商务", "回款", "客户"],
        "field_notes": {
            "revenue": "交付收入（元），按已交付条数 × 单价确认，不含税",
            "contract": "本期新签合同额（元）",
            "receivable": "应收金额（元）= 已到期应收，不含未到期部分",
            "received": "已回款（元），含预付款与进度款",
            "arrears": "欠款余额（元）= receivable - received，可能为负（预收）",
            "payment_rate": "回款率（%）= received / receivable。只在 receivable > 0 时有意义",
            "avg_price": "单价（元/条）= revenue / units_delivered",
            "avg_term": "平均账期（天），合同约定",
            "tier": "客户分层（战略 / KA / 一般），分层口径由商务维护",
        },
        "examples": [
            {
                "title": "客户收入与欠款",
                "note": "按客户看收入和欠款余额，找出回款慢的大客户",
                "query": "dims=customer&metrics=revenue,received,arrears&limit=50",
            },
            {
                "title": "分层回款率与账期",
                "note": "战略客户回款率明显高于一般客户，账期也更短",
                "query": "dims=tier&metrics=revenue,payment_rate,avg_term&limit=20",
            },
        ],
    },
    "robot_pipeline": {
        "description": "跨环节全流程视角：同一天里数采 / 标注 / 质检各产出了多少、通过率如何。适合做环节间对比，不适合跨环节求和。",
        "owner": "数据平台 · 架构组",
        "update_freq": "每日 09:30（汇总全链路）",
        "tags": ["全流程", "产能"],
        "field_notes": {
            "output_units": "各环节的产出单元数。**环节之间口径不同**（条 / 标注对象 / 抽检样本），不要跨环节求和",
            "tasks": "任务数（按环节定义不同）",
            "pass_rate": "环节通过率（%）；分母是该环节的提交量",
            "work_hours": "环节工时（小时），可跨环节相加",
            "staff_cnt": "该环节当日参与人数（去重），不能跨环节相加",
            "per_person": "人均产出，口径随环节变化",
        },
        "examples": [
            {
                "title": "各环节每日产出",
                "note": "同一张图里对比三个环节的节拍；注意单位不同，看形状不看高低",
                "query": "dims=date,stage&metrics=output_units,work_hours&limit=1000",
            },
            {
                "title": "各环节通过率",
                "note": "标注环节常年最低，是质量瓶颈",
                "query": "dims=stage&metrics=output_units,pass_rate,work_hours&limit=20",
            },
        ],
    },
}

# ---------------------------------------------------------------------------
# 五个数据集。四个角色各一份，外加一份跨环节的全流程视角。
# 所有口径都写在 mid_sql 里的 JOIN，前端拿到的永远是翻译好的中文名。
# ---------------------------------------------------------------------------

COLLECTION = {
    "dataset_key": "robot_collection",
    "dataset_name": "具身—数采明细（近30天）",
    "mid_sql": """
select
    e.stat_date                     as stat_date,
    s.staff_name                    as collector_name,
    s.team                          as team,
    s.level                         as level,
    s.city                          as city,
    sc.scene_name                   as scene_name,
    sc.category                     as scene_category,
    sc.difficulty                   as scene_difficulty,
    r.model                         as robot_model,
    r.vendor                        as vendor,
    r.firmware                      as firmware,
    e.shift                         as shift,
    e.modality                      as modality,
    e.batch_no                      as batch_no,
    e.valid                         as valid,
    e.reject_reason                 as reject_reason,
    e.duration_sec                  as duration_sec,
    e.frames                        as frames,
    e.traj_points                   as traj_points,
    e.storage_gb                    as storage_gb,
    e.quality_score                 as quality_score
from embodied.fact_collection_episode e
left join embodied.dim_staff s  on e.collector_id = s.staff_id
left join embodied.dim_robot r  on e.robot_id     = r.robot_id
left join embodied.dim_scene sc on e.scene_id     = sc.scene_id
""",
    "dim_map": {
        "date": "stat_date",
        "collector": "collector_name",
        "team": "team",
        "level": "level",
        "city": "city",
        "scene": "scene_name",
        "category": "scene_category",
        "difficulty": "scene_difficulty",
        "robot_model": "robot_model",
        "vendor": "vendor",
        "firmware": "firmware",
        "shift": "shift",
        "modality": "modality",
        "batch_no": "batch_no",
        "valid": "valid",
        "reject_reason": "reject_reason",
    },
    "mtx_map": {
        "episodes": "count()",
        "valid_episodes": "sum(valid)",
        "total_hours": "round(sum(duration_sec) / 3600, 1)",
        "valid_hours": "round(sum(if(valid = 1, duration_sec, 0)) / 3600, 1)",
        "frames": "sum(frames)",
        "valid_frames": "sum(if(valid = 1, frames, 0))",
        "storage_gb": "sum(storage_gb)",
        "avg_duration": "round(avg(duration_sec), 1)",
        "avg_quality": "round(avg(quality_score), 2)",
        "valid_rate": "round(sum(valid) / count() * 100, 2)",
        "collectors": "uniq(collector_name)",
        "per_person": "round(count() / uniq(collector_name), 1)",
    },
}

ANNOTATION = {
    "dataset_key": "robot_annotation",
    "dataset_name": "具身—标注产出明细（近30天）",
    "mid_sql": """
select
    a.stat_date                     as stat_date,
    s.staff_name                    as annotator_name,
    s.team                          as team,
    s.level                         as level,
    s.city                          as city,
    sc.scene_name                   as scene_name,
    sc.category                     as scene_category,
    sc.difficulty                   as difficulty,
    a.anno_type                     as anno_type,
    a.tool_version                  as tool_version,
    a.shift                         as shift,
    a.first_pass                    as first_pass,
    a.skill_tags                    as skill_tags,
    a.unit_count                    as unit_count,
    a.frame_count                   as frame_count,
    a.duration_sec                  as duration_sec,
    a.rework_count                  as rework_count,
    a.accuracy_score                as accuracy_score
from embodied.fact_annotation_unit a
left join embodied.dim_staff s  on a.annotator_id = s.staff_id
left join embodied.dim_scene sc on a.scene_id     = sc.scene_id
""",
    "dim_map": {
        "date": "stat_date",
        "annotator": "annotator_name",
        "team": "team",
        "level": "level",
        "city": "city",
        "scene": "scene_name",
        "category": "scene_category",
        "difficulty": "difficulty",
        "anno_type": "anno_type",
        "tool_version": "tool_version",
        "shift": "shift",
        "first_pass": "first_pass",
    },
    # 一个任务单元同时涉及多个技能标签：进 GROUP BY 会按标签拆行，
    # 那回答的是「标了几个技能」，不是业务要的「这单标了什么」
    "multi_dim_map": {"skill_tags": "skill_tags"},
    "mtx_map": {
        "tasks": "count()",
        "units": "sum(unit_count)",
        "frames": "sum(frame_count)",
        "work_hours": "round(sum(duration_sec) / 3600, 1)",
        "rework": "sum(rework_count)",
        "pass_tasks": "sum(first_pass)",
        "pass_rate": "round(sum(first_pass) / count() * 100, 2)",
        "avg_accuracy": "round(avg(accuracy_score), 2)",
        "annotators": "uniq(annotator_name)",
        "per_person": "round(sum(unit_count) / uniq(annotator_name), 1)",
    },
}

QC = {
    "dataset_key": "robot_qc",
    "dataset_name": "具身—质检抽检明细（近30天）",
    "mid_sql": """
select
    q.stat_date                     as stat_date,
    s.staff_name                    as checker_name,
    s.team                          as team,
    s.level                         as level,
    q.stage                         as stage,
    sc.scene_name                   as scene_name,
    sc.category                     as scene_category,
    sc.difficulty                   as difficulty,
    q.defect_type                   as defect_type,
    q.severity                      as severity,
    q.verdict                       as verdict,
    q.batch_no                      as batch_no,
    q.sample_count                  as sample_count,
    q.defect_count                  as defect_count,
    q.repair_sec                    as repair_sec
from embodied.fact_qc_sample q
left join embodied.dim_staff s  on q.checker_id = s.staff_id
left join embodied.dim_scene sc on q.scene_id   = sc.scene_id
""",
    "dim_map": {
        "date": "stat_date",
        "checker": "checker_name",
        "team": "team",
        "level": "level",
        "stage": "stage",
        "scene": "scene_name",
        "category": "scene_category",
        "difficulty": "difficulty",
        "defect_type": "defect_type",
        "severity": "severity",
        "verdict": "verdict",
        "batch_no": "batch_no",
    },
    "mtx_map": {
        "checks": "count()",
        "samples": "sum(sample_count)",
        "defects": "sum(defect_count)",
        "pass_samples": "sum(if(verdict = '通过', sample_count, 0))",
        "pass_rate": "round(sum(if(verdict = '通过', sample_count, 0)) / sum(sample_count) * 100, 2)",
        "repair_hours": "round(sum(repair_sec) / 3600, 1)",
        "scrap": "sum(if(verdict = '报废', 1, 0))",
        "checkers": "uniq(checker_name)",
    },
}

BUSINESS = {
    "dataset_key": "robot_business",
    "dataset_name": "具身—客户交付与回款（近30天）",
    "mid_sql": """
select
    d.stat_date                     as stat_date,
    c.customer_name                 as customer_name,
    c.industry                      as industry,
    c.region                        as region,
    c.tier                          as tier,
    b.staff_name                    as bd_name,
    sc.scene_name                   as scene_name,
    sc.category                     as scene_category,
    d.project_id                    as project_id,
    d.project_name                  as project_name,
    d.phase                         as phase,
    d.pay_term_days                 as pay_term_days,
    d.delivered_units               as delivered_units,
    d.delivered_frames              as delivered_frames,
    d.unit_price                    as unit_price,
    d.revenue                       as revenue,
    d.contract_amount               as contract_amount,
    d.receivable                    as receivable,
    d.received                      as received,
    d.arrears                       as arrears,
    d.gross_margin_rate             as gross_margin_rate,
    d.satisfaction                  as satisfaction
from embodied.fact_delivery_daily d
left join embodied.dim_customer c on d.customer_id = c.customer_id
left join embodied.dim_staff b    on d.bd_id       = b.staff_id
left join embodied.dim_scene sc   on d.scene_id    = sc.scene_id
""",
    "dim_map": {
        "date": "stat_date",
        "customer": "customer_name",
        "industry": "industry",
        "region": "region",
        "tier": "tier",
        "bd": "bd_name",
        "scene": "scene_name",
        "category": "scene_category",
        "project_id": "project_id",
        "project_name": "project_name",
        "phase": "phase",
        "pay_term_days": "pay_term_days",
    },
    "mtx_map": {
        "units_delivered": "sum(delivered_units)",
        "delivered_frames": "sum(delivered_frames)",
        "revenue": "sum(revenue)",
        "contract": "sum(contract_amount)",
        "receivable": "sum(receivable)",
        "received": "sum(received)",
        "arrears": "sum(arrears)",
        "payment_rate": "round(sum(received) / sum(receivable) * 100, 2)",
        "avg_price": "round(avg(unit_price), 2)",
        "gross_margin": "round(avg(gross_margin_rate) * 100, 2)",
        "avg_term": "round(avg(pay_term_days), 1)",
        "satisfaction": "round(avg(satisfaction), 2)",
        "customers": "uniq(customer_name)",
        "projects": "uniq(project_id)",
        "bds": "uniq(bd_name)",
    },
}

# 跨环节视角：采集 / 标注 / 质检三张事实表 UNION 成一张，
# 用来回答「今天的产出卡在哪个环节」。三个环节的粒度不同，对齐到
# 「任务数 / 产出单元 / 合格单元 / 投入工时」这几个可比口径上。
PIPELINE = {
    "dataset_key": "robot_pipeline",
    "dataset_name": "具身—全流程产能（近30天）",
    "mid_sql": """
select
    e.stat_date                     as stat_date,
    '采集'                          as stage,
    s.staff_name                    as staff_name,
    s.team                          as team,
    sc.scene_name                   as scene_name,
    sc.difficulty                   as difficulty,
    toUInt32(1)                     as units,
    e.valid                         as ok_units,
    e.duration_sec                  as seconds
from embodied.fact_collection_episode e
left join embodied.dim_staff s  on e.collector_id = s.staff_id
left join embodied.dim_scene sc on e.scene_id     = sc.scene_id
union all
select
    a.stat_date                     as stat_date,
    '标注'                          as stage,
    s.staff_name                    as staff_name,
    s.team                          as team,
    sc.scene_name                   as scene_name,
    sc.difficulty                   as difficulty,
    a.unit_count                    as units,
    a.first_pass                    as ok_units,
    a.duration_sec                  as seconds
from embodied.fact_annotation_unit a
left join embodied.dim_staff s  on a.annotator_id = s.staff_id
left join embodied.dim_scene sc on a.scene_id     = sc.scene_id
union all
select
    q.stat_date                     as stat_date,
    '质检'                          as stage,
    s.staff_name                    as staff_name,
    s.team                          as team,
    sc.scene_name                   as scene_name,
    sc.difficulty                   as difficulty,
    toUInt32(q.sample_count)        as units,
    if(q.verdict = '通过', 1, 0)    as ok_units,
    greatest(q.repair_sec, 30)      as seconds
from embodied.fact_qc_sample q
left join embodied.dim_staff s  on q.checker_id = s.staff_id
left join embodied.dim_scene sc on q.scene_id   = sc.scene_id
""",
    "dim_map": {
        "date": "stat_date",
        "stage": "stage",
        "staff": "staff_name",
        "team": "team",
        "scene": "scene_name",
        "difficulty": "difficulty",
    },
    "mtx_map": {
        "tasks": "count()",
        # 键名不叫 units：标注数据集里的 units 是「标注对象数」，
        # 这里是「产出单元」，同一份全局字典里不能用同一个键表达两个口径
        "output_units": "sum(units)",
        "pass_tasks": "sum(ok_units)",
        "work_hours": "round(sum(seconds) / 3600, 1)",
        "pass_rate": "round(sum(ok_units) / count() * 100, 2)",
        "per_person": "round(count() / uniq(staff_name), 1)",
        "staff_cnt": "uniq(staff_name)",
    },
}

DATASETS = [COLLECTION, ANNOTATION, QC, BUSINESS, PIPELINE]

# 每个数据集的冒烟查询：验证配置真能跑出数，而不是只写在库里好看
SMOKE = {
    "robot_collection": (["date"], ["episodes", "valid_episodes", "valid_rate"]),
    "robot_annotation": (["anno_type"], ["tasks", "units", "pass_rate"]),
    "robot_qc": (["stage"], ["checks", "samples", "pass_rate"]),
    "robot_business": (["tier"], ["units_delivered", "revenue", "arrears", "payment_rate"]),
    "robot_pipeline": (["stage"], ["tasks", "output_units", "work_hours", "pass_rate"]),
}


def request(method: str, path: str, payload: dict | None = None) -> tuple[int, dict]:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(
        BASE + path,
        data=data,
        headers={"Content-Type": "application/json", "X-User": OPERATOR},
        method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read().decode("utf-8")
            return resp.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8")
        try:
            return e.code, json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            return e.code, {"message": raw[:200]}
    except Exception as e:  # noqa: BLE001
        return 0, {"message": str(e)}


def post(path: str, payload: dict) -> tuple[int, dict]:
    return request("POST", path, payload)


def get(path: str) -> tuple[int, dict]:
    req = urllib.request.Request(BASE + path, headers={"X-User": OPERATOR})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8") or "{}")


# 早期按列名注册错的那批，现在没有任何数据集引用它们。
# 不删掉会在「字段名称」一致性检查里显示成一堆孤儿，看起来像配置没收拾干净。
RETIRED_LABELS = [
    "collector_name", "annotator_name", "checker_name", "bd_name",
    "staff_name", "scene_name", "scene_category", "scene_difficulty",
    "customer_name", "project_name",
]


def retire_labels() -> None:
    status, data = get("/api/v1/labels?size=500")
    if status != 200:
        return
    by_key = {it["field_key"]: it for it in data.get("data", {}).get("items", [])}
    for key in RETIRED_LABELS:
        if key in by_key:
            code, _ = request("DELETE", f"/api/v1/labels/{key}")
            print(f"  停用 {key}: {code}")


def ensure_labels() -> None:
    status, data = get("/api/v1/labels?size=500")
    existing = {}
    if status == 200:
        for it in data.get("data", {}).get("items", []):
            existing[it["field_key"]] = it["label"]
    added = updated = 0
    for key, label in GLOBAL_LABELS.items():
        if existing.get(key) == label:
            continue
        # 创建返回 201、更新返回 200，统一按 2xx 判成功
        if key in existing:
            code, body = request("PUT", f"/api/v1/labels/{key}", {"label": label, "version": 0})
            ok = 200 <= code < 300
            updated += ok
        else:
            code, body = post("/api/v1/labels", {"field_key": key, "label": label})
            ok = 200 <= code < 300
            added += ok
        if not ok:
            print(f"  ! 字段名 {key} 写入失败 ({code}): {body.get('message', '')}")
    print(f"全局字段名：新增 {added}，更新 {updated}，已是最新 {len(GLOBAL_LABELS) - added - updated}")


def upsert_dataset(ds: dict, update: bool) -> tuple[int, dict]:
    key = ds["dataset_key"]
    body_fields = {
        "dataset_name": ds["dataset_name"],
        "mid_sql": ds["mid_sql"],
        "dim_map": ds["dim_map"],
        "multi_dim_map": ds.get("multi_dim_map", {}),
        "mtx_map": ds["mtx_map"],
        "acl": {},
        "meta": META.get(key, {}),
    }
    if update:
        _, detail = get(f"/api/v1/datasets/{key}")
        version = (detail.get("data") or {}).get("version", 0)
        code, body = request("PUT", f"/api/v1/datasets/{key}", {**body_fields, "version": version})
        print(f"[update] {key}: {code} {body.get('message', '')}")
        return code, body
    code, body = post("/api/v1/datasets", {"dataset_key": key, **body_fields})
    print(f"[create] {key}: {code} {body.get('message', '')}")
    return code, body


def ensure_datasets(dry_run: bool) -> None:
    for ds in DATASETS:
        key = ds["dataset_key"]
        payload = {
            "dataset_key": key,
            "dataset_name": ds["dataset_name"],
            "mid_sql": ds["mid_sql"],
            "dim_map": ds["dim_map"],
            "multi_dim_map": ds.get("multi_dim_map", {}),
            "mtx_map": ds["mtx_map"],
        }
        if dry_run:
            code, body = post("/api/v1/datasets/dry-run", payload)
            print(f"[dry-run] {key}: {code} {body.get('message', '')}")
            continue

        status, _ = get(f"/api/v1/datasets/{key}")
        if status == 200:
            upsert_dataset(ds, update=True)
        else:
            upsert_dataset(ds, update=False)


def smoke() -> None:
    for key, (dims, metrics) in SMOKE.items():
        code, body = post(
            "/api/v1/query/execute",
            {
                "dataset_key": key,
                "dims": dims,
                "metrics": metrics,
                "limit": 5,
            },
        )
        data = body.get("data") or {}
        rows = data.get("rows")
        n = len(rows) if rows else 0
        sample = rows[0] if n else None
        print(f"[smoke] {key}: http={code} rows={n} 第一行={sample}")


def main() -> int:
    global BASE
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=BASE)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--skip-smoke", action="store_true")
    args = ap.parse_args()
    BASE = args.base.rstrip("/")

    print("== 1/3 全局字段名 ==")
    if args.dry_run:
        print("跳过（--dry-run 不写任何数据）")
    else:
        retire_labels()
        ensure_labels()
    print("\n== 2/3 数据集配置 ==")
    ensure_datasets(args.dry_run)
    if not args.dry_run and not args.skip_smoke:
        print("\n== 3/3 冒烟查询 ==")
        smoke()
    return 0


if __name__ == "__main__":
    sys.exit(main())
