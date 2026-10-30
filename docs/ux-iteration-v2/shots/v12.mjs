// v12：指标摘要卡 —— 一屏看出规模、集中度、趋势，而不是先心算二十行
import { ensureDir, launch, queryUrl, screenshot, waitResult } from './harness.mjs';

ensureDir();
const { browser, page, errors } = await launch();
try {
  // 场景一：按场景看产出，四张卡分别覆盖「可加 + 集中度」与「比率 + 范围」
  await page.goto(
    queryUrl({
      ds: 'robot_pipeline',
      dims: 'scene',
      metrics: 'output_units,tasks,work_hours,pass_rate',
      limit: 1000,
    }),
    { waitUntil: 'networkidle' },
  );
  await waitResult(page);
  await screenshot(page, 'v12-指标卡-场景维度');
  await screenshot(page, 'v12-指标卡特写', { clip: { x: 480, y: 60, width: 1100, height: 260 } });

  // 场景二：时间维度 → 卡片自带迷你趋势线
  await page.goto(
    queryUrl({ ds: 'robot_pipeline', dims: 'date', metrics: 'output_units,pass_rate,staff_cnt', limit: 1000 }),
    { waitUntil: 'networkidle' },
  );
  await waitResult(page);
  await screenshot(page, 'v12-指标卡-时间维度带趋势');

  // 场景三：无维度 = 只有一行，表格几乎没信息量，卡片才是主体
  await page.goto(
    queryUrl({ ds: 'robot_collection', metrics: 'episodes,valid_rate,storage_gb,total_hours' }),
    { waitUntil: 'networkidle' },
  );
  await waitResult(page);
  await screenshot(page, 'v12-汇总口径-纯KPI');
} finally {
  if (errors.length) console.log('控制台异常：', errors.slice(0, 5));
  await browser.close();
}
