// v16：多指标分面 —— 量级差三个数量级时，图不能硬画在一根轴上
import { ensureDir, launch, queryUrl, screenshot, waitResult } from './harness.mjs';

ensureDir();
const { browser, page, errors } = await launch();

try {
  // 产出单元 9.4 万 vs 任务数 144 万 vs 通过率 89：三个量纲，一根 Y 轴必然压平
  await page.goto(
    queryUrl({
      ds: 'robot_pipeline',
      dims: 'date',
      metrics: 'output_units,tasks,pass_rate,work_hours',
      limit: 1000,
    }),
    { waitUntil: 'networkidle' },
  );
  await waitResult(page);
  await page.getByRole('tab', { name: /折线图/ }).click();
  await page.waitForTimeout(2200);
  await screenshot(page, 'v16-分面-四指标各一根Y轴');

  // 切回合并，让「被压平」这件事自己说话
  // antd Segmented 的 radio input 是隐藏的，要点可见的 label
  await page.getByText('合并', { exact: true }).click();
  await page.waitForTimeout(2200);
  await screenshot(page, 'v16-合并-小量级被压平');

  // 单指标场景不该出现分面开关
  await page.goto(
    queryUrl({ ds: 'robot_collection', dims: 'date', metrics: 'episodes', limit: 1000 }),
    { waitUntil: 'networkidle' },
  );
  await waitResult(page);
  await page.getByRole('tab', { name: /柱状图/ }).click();
  await page.waitForTimeout(2000);
  await screenshot(page, 'v16-单指标-不显示分面开关');
} finally {
  if (errors.length) console.log('控制台异常：', errors.slice(0, 5));
  await browser.close();
}
