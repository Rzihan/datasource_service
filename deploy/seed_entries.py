#!/usr/bin/env python3
"""给 demo 数据集挂「菜单入口」（meta.entry）。

入口回答的是迁移问题：历史用户点他熟悉的旧菜单，就能到可视化查询版，
不用先去查询页、再在数据集列表里认出哪个是自己原来那张表。

用法：
    python3 deploy/seed_entries.py [http://127.0.0.1:8080]

注意：后端要先重启过（entry 是新增字段），否则 PUT 进去会被 normalizeMeta 丢掉。
"""
import json
import sys
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8080"


def http(method, path, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        BASE + path,
        data=data,
        method=method,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())["data"]


# 每个入口 = 数据集 + 挂在哪个旧页面上 + 打开时跑什么。
# default_query 刻意挑「跟旧页表头最接近」的那一屏：
# 迁移第一眼的判断是「这跟我原来那张表是不是一回事」，对得上才谈得上留下。
ENTRIES = {
    "robot_collection": {
        "key": "collect-daily",
        "title": "采集任务日报",
        "module": "数据采集",
        "legacy": "collect_daily",
        "status": "parallel",
        "note": "与旧页同一份采集明细：日期 × 团队看采集条数与时长。旧页口径固定，这里可以自己换维度、加筛选、看环比。",
        "default_query": "dims=date,team&metrics=episodes,total_hours,avg_quality&order=date&dir=asc&limit=1000",
        "sort": 10,
    },
    "robot_annotation": {
        "key": "anno-capacity",
        "title": "标注产能看板",
        "module": "数据标注",
        "legacy": "anno_capacity",
        "status": "default",
        "note": "与旧页同一份标注产出：按标注员看帧数、一次通过率与返工。旧页只能按人看，这里还能按类型、班次、场景拆。",
        "default_query": "dims=annotator&metrics=frames,pass_rate,rework&order=frames&dir=desc&limit=1000",
        "sort": 10,
    },
    "robot_qc": {
        "key": "qc-report",
        "title": "质检日报",
        "module": "质量检验",
        "legacy": "qc_report",
        "status": "replaced",
        "note": "与旧页同一份质检明细：按批次看抽检数、缺陷数与通过率。缺陷类型在旧页固定六类，这里按数据里的实际取值展示。",
        "default_query": "dims=date,batch_no&metrics=samples,defects,pass_rate&order=date&dir=desc&limit=1000",
        "sort": 10,
    },
    "robot_business": {
        "key": "biz-delivery",
        "title": "交付与回款台账",
        "module": "商务交付",
        "legacy": "biz_delivery",
        "status": "parallel",
        "note": "与旧页同一份交付数据：按客户看交付帧数、合同额与账期。旧页每月导一次，这里可以按行业、阶段、负责人随时拆。",
        "default_query": "dims=customer,industry&metrics=delivered_frames,contract,receivable,avg_term&order=delivered_frames&dir=desc&limit=1000",
        "sort": 10,
    },
    "robot_pipeline": {
        "key": "ops-pipeline",
        "title": "全流程产能日报",
        "module": "运营管理",
        "legacy": "ops_pipeline",
        "status": "default",
        "note": "与旧页同一份全流程数据：采集 → 标注 → 质检的任务流转与产出。旧页三个环节写死，这里可以按场景、难度继续下钻。",
        "default_query": "dims=date,stage&metrics=tasks,output_units,pass_rate&order=date&dir=desc&limit=1000",
        "sort": 10,
    },
}


def main():
    for key, entry in ENTRIES.items():
        cfg = http("GET", f"/api/v1/datasets/{key}")
        meta = cfg.get("meta") or {}
        meta["entry"] = entry
        http("PUT", f"/api/v1/datasets/{key}", {
            "dataset_name": cfg["dataset_name"],
            "mid_sql": cfg["mid_sql"],
            "dim_map": cfg["dim_map"],
            "multi_dim_map": cfg.get("multi_dim_map") or {},
            "mtx_map": cfg["mtx_map"],
            "label_map": cfg.get("label_map") or {},
            "acl": cfg.get("acl") or {},
            "status": cfg.get("status", 1),
            "meta": meta,
            "version": cfg["version"],
        })
        print(f"entry mounted: {key} -> /e/{entry['key']}  (legacy={entry['legacy']})")


if __name__ == "__main__":
    main()
