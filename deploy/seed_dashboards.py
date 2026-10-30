#!/usr/bin/env python3
"""给 demo 环境造几张「大盘」。

大盘回答的是「替换不了一个页面」的问题：
旧的大盘页上面一排指标、中间趋势图、下面明细表，三块东西来自三次查询。
单次可视化查询只能替代其中一块，所以拿它去替换一个页面必然是降级的——
能对位的是「一张大盘」，不是「一次查询」。

用法：
    python3 deploy/seed_dashboards.py [http://127.0.0.1:8080]
"""
import json
import sys
import urllib.error
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


def q(**kw):
    """拼查询串：与查询页 URL 里 ds 之后那一段同格式。"""
    return "&".join(f"{k}={v}" for k, v in kw.items())


# 面板 = 数据集 + 查询 + 画成什么 + 占多宽多高。
# 布局刻意模仿旧大盘页的形状：上面一排指标卡（span 3，四张正好一行），
# 中间趋势图整行，下面左图右表——视觉上的「熟悉」是大盘能替代旧页的一半原因。
COLLECT = {
    "key": "collect-overview",
    "title": "采集任务日报",
    "module": "数据采集",
    "legacy": "collect_daily",
    "owner": "数采组",
    "desc": "旧页的采集日报原样搬过来：上面四个数是当天规模，中间看趋势，下面是明细。口径与旧页一致，只是每块都能自己换维度。",
    "panels": [
        {"id": "m1", "title": "采集条数", "dataset": "robot_collection", "view": "metric",
         "query": q(metrics="episodes", limit="200"), "span": 3, "height": 150, "metric": "episodes"},
        {"id": "m2", "title": "采集时长（小时）", "dataset": "robot_collection", "view": "metric",
         "query": q(metrics="total_hours", limit="200"), "span": 3, "height": 150, "metric": "total_hours"},
        {"id": "m3", "title": "有效率", "dataset": "robot_collection", "view": "metric",
         "query": q(metrics="valid_rate", limit="200"), "span": 3, "height": 150, "metric": "valid_rate",
         "note": "比率不可加，这里显示的是行均值，不是加总"},
        {"id": "m4", "title": "有效帧数", "dataset": "robot_collection", "view": "metric",
         "query": q(metrics="valid_frames", limit="200"), "span": 3, "height": 150, "metric": "valid_frames"},
        {"id": "t1", "title": "每日采集条数趋势", "dataset": "robot_collection", "view": "line",
         "query": q(dims="date", metrics="episodes,valid_episodes", order="date", dir="asc", limit="500"),
         "span": 12, "height": 260},
        {"id": "c1", "title": "各团队采集条数", "dataset": "robot_collection", "view": "column",
         "query": q(dims="team", metrics="episodes", order="episodes", dir="desc", limit="50"),
         "span": 6, "height": 280},
        {"id": "p1", "title": "场景分布", "dataset": "robot_collection", "view": "pie",
         "query": q(dims="scene", metrics="episodes", order="episodes", dir="desc", limit="20"),
         "span": 6, "height": 280},
        {"id": "d1", "title": "采集明细（近 50 条）", "dataset": "robot_collection", "view": "table",
         "query": q(dims="date,team,collector", metrics="episodes,total_hours,valid_rate,avg_quality",
                    order="date", dir="desc", limit="50"),
         "span": 12, "height": 320},
    ],
}

QC = {
    "key": "qc-daily",
    "title": "质检日报",
    "module": "质量检验",
    "legacy": "qc_report",
    "owner": "质检组",
    "desc": "旧质检日报的大盘版：上面是当天抽检规模与缺陷，中间看通过率的走势，下面按批次下钻明细。",
    "panels": [
        {"id": "m1", "title": "抽检样本", "dataset": "robot_qc", "view": "metric",
         "query": q(metrics="samples", limit="200"), "span": 3, "height": 150, "metric": "samples"},
        {"id": "m2", "title": "缺陷数", "dataset": "robot_qc", "view": "metric",
         "query": q(metrics="defects", limit="200"), "span": 3, "height": 150, "metric": "defects"},
        {"id": "m3", "title": "通过率", "dataset": "robot_qc", "view": "metric",
         "query": q(metrics="pass_rate", limit="200"), "span": 3, "height": 150, "metric": "pass_rate"},
        {"id": "m4", "title": "返修工时", "dataset": "robot_qc", "view": "metric",
         "query": q(metrics="repair_hours", limit="200"), "span": 3, "height": 150, "metric": "repair_hours"},
        {"id": "t1", "title": "抽检与缺陷趋势", "dataset": "robot_qc", "view": "line",
         "query": q(dims="date", metrics="samples,defects", order="date", dir="asc", limit="500"),
         "span": 12, "height": 260},
        {"id": "c1", "title": "各团队通过率", "dataset": "robot_qc", "view": "column",
         "query": q(dims="team", metrics="pass_rate", order="pass_rate", dir="desc", limit="50"),
         "span": 6, "height": 280, "note": "通过率是比率，按团队看的是各自的行均值"},
        {"id": "p1", "title": "缺陷类型分布", "dataset": "robot_qc", "view": "pie",
         "query": q(dims="defect_type", metrics="defects", order="defects", dir="desc", limit="20"),
         "span": 6, "height": 280},
        {"id": "d1", "title": "质检明细（近 50 条）", "dataset": "robot_qc", "view": "table",
         "query": q(dims="date,batch_no,checker", metrics="samples,defects,pass_rate,repair_hours",
                    order="date", dir="desc", limit="50"),
         "span": 12, "height": 320},
    ],
}

ANNO = {
    "key": "anno-board",
    "title": "标注产能看板",
    "module": "数据标注",
    "legacy": "anno_capacity",
    "owner": "标注组",
    "desc": "旧产能看板的大盘版：上面是当天产出规模，中间看人均产能走势，下面是按人/按类型的明细。",
    "panels": [
        {"id": "m1", "title": "标注帧数", "dataset": "robot_annotation", "view": "metric",
         "query": q(metrics="frames", limit="200"), "span": 4, "height": 150, "metric": "frames"},
        {"id": "m2", "title": "一次通过率", "dataset": "robot_annotation", "view": "metric",
         "query": q(metrics="pass_rate", limit="200"), "span": 4, "height": 150, "metric": "pass_rate"},
        {"id": "m3", "title": "任务数", "dataset": "robot_annotation", "view": "metric",
         "query": q(metrics="tasks", limit="200"), "span": 4, "height": 150, "metric": "tasks"},
        {"id": "t1", "title": "每日标注帧数", "dataset": "robot_annotation", "view": "line",
         "query": q(dims="date", metrics="frames,units", order="date", dir="asc", limit="500"),
         "span": 8, "height": 280},
        {"id": "c1", "title": "各类型产出", "dataset": "robot_annotation", "view": "column",
         "query": q(dims="anno_type", metrics="frames", order="frames", dir="desc", limit="30"),
         "span": 4, "height": 280},
        {"id": "d1", "title": "标注员明细", "dataset": "robot_annotation", "view": "table",
         "query": q(dims="annotator,team", metrics="frames,tasks,pass_rate,rework,work_hours",
                    order="frames", dir="desc", limit="50"),
         "span": 12, "height": 320},
    ],
}

DASHBOARDS = [COLLECT, QC, ANNO]


def main():
    for d in DASHBOARDS:
        try:
            cur = http("GET", f"/api/v1/dashboards/{d['key']}")
            payload = dict(d)
            payload["version"] = cur["version"]
            http("PUT", f"/api/v1/dashboards/{d['key']}", payload)
            print(f"dashboard updated: {d['key']}  ({len(d['panels'])} 面板)")
        except urllib.error.HTTPError as e:
            if e.code != 404:
                raise
            http("POST", "/api/v1/dashboards", d)
            print(f"dashboard created: {d['key']}  ({len(d['panels'])} 面板)")


if __name__ == "__main__":
    main()
