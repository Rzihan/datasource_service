// v13：同环比 —— 不再查两次、再用 Excel 拼一张对比表
import { ensureDir, launch, queryUrl, screenshot, waitResult } from './harness.mjs';

ensureDir();
const { browser, page, errors } = await launch();

const range = (from, to) => ({
  logic: 'and',
  children: [
    { field: 'date', op: '>=', value: from },
    { field: 'date', op: '<=', value: to },
  ],
});

try {
  // 场景一：按任务场景看近 14 天 vs 前 14 天
  await page.goto(
    queryUrl({
      ds: 'robot_collection',
      dims: 'scene',
      metrics: 'episodes,valid_rate',
      filter: range('2026-10-17', '2026-10-30'),
      cmp: 'prev_period',
      cmpf: 'date',
      limit: 1000,
    }),
    { waitUntil: 'networkidle' },
  );
  await waitResult(page);
  await screenshot(page, 'v13-环比-场景对比');
  await screenshot(page, 'v13-环比-表头特写', { clip: { x: 480, y: 60, width: 1100, height: 440 } });

  // 场景二：按天看「本周 vs 上周」——日期维度上做环比就是周同比
  await page.goto(
    queryUrl({
      ds: 'robot_collection',
      dims: 'date',
      metrics: 'episodes',
      filter: range('2026-10-24', '2026-10-30'),
      cmp: 'prev_period',
      cmpf: 'date',
      limit: 1000,
    }),
    { waitUntil: 'networkidle' },
  );
  await waitResult(page);
  await screenshot(page, 'v13-环比-按天周同比', { clip: { x: 480, y: 60, width: 1100, height: 620 } });

  // 场景三：去年同期没有数据——界面要说「上期无数据」，而不是假装 0
  await page.goto(
    queryUrl({
      ds: 'robot_collection',
      dims: 'scene',
      metrics: 'episodes',
      filter: range('2026-10-24', '2026-10-30'),
      cmp: 'prev_year',
      cmpf: 'date',
      limit: 1000,
    }),
    { waitUntil: 'networkidle' },
  );
  await waitResult(page);
  await screenshot(page, 'v13-同比-无上期数据也说清楚');
} finally {
  if (errors.length) console.log('控制台异常：', errors.slice(0, 5));
  await browser.close();
}
