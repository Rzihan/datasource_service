#!/usr/bin/env python3
"""给 demo 数据集补「说明书」（meta）。

v15 给 robot_* 五个数据集写过 meta，demo_* 两个没写——于是它们成了对照组：
打开查询页就能看到「负责人：未填写 / 更新频率：未填写」。
留着这个对照组是有意的：数据集作者能看到「不写说明书是什么样」。

demo_order 的更新频率故意写成「每日」：它的数据停在 2026-10-20，
于是体检卡会诚实地报「数据可能滞后」——用来验证新鲜度告警真的会亮。

用法：
    python3 deploy/seed_demo_meta.py [http://127.0.0.1:8080]
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


META = {
    "demo_order": {
        "description": "广告投放订单演示集：渠道 × 城市 × 日期的消耗、点击与 UV。用于验证看板功能，数据一次性生成、停在 2026-10-20。",
        "owner": "示例 · 数据平台",
        "update_freq": "每日",
        "tags": ["演示", "广告投放"],
        "field_notes": {
            "cost": "消耗金额（元），含税",
            "clicks": "点击次数，不去重",
            "uv": "去重用户数，跨渠道不重复计数",
            "companies": "多值维度：一条订单可能同时归属多个公司主体，值是收拢后的列表",
        },
        "examples": [
            {
                "title": "各渠道消耗与点击",
                "note": "看哪个渠道花钱最多、点击最贵",
                "query": "dims=channel&metrics=cost,clicks&limit=1000",
            }
        ],
    },
    "demo_tmpl": {
        "description": "城市分级演示集：验证 mid_sql 模板渲染（按需裁剪 JOIN）用的最小数据集。",
        "tags": ["演示", "模板"],
        "field_notes": {
            "city_tier": "城市分级：一线 / 新一线 / 二线",
            "uv": "去重用户数",
        },
    },
}


def main():
    for key, meta in META.items():
        cur = http("GET", f"/api/v1/datasets/{key}")
        body = {
            "dataset_name": cur["dataset_name"],
            "mid_sql": cur["mid_sql"],
            "dim_map": cur["dim_map"],
            "multi_dim_map": cur.get("multi_dim_map") or {},
            "mtx_map": cur["mtx_map"],
            "label_map": cur.get("label_map") or {},
            "acl": cur.get("acl") or {},
            "meta": meta,
            "status": cur.get("status", 1),
            "version": cur["version"],
        }
        out = http("PUT", f"/api/v1/datasets/{key}", body)
        print(f"{key}: version {cur['version']} -> {out['version']}, owner={out['meta'].get('owner') or '未填写'}")


if __name__ == "__main__":
    main()
