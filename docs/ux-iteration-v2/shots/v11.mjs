// v11：结果概览条 —— 「是不是全量」「覆盖到哪天」「合计多少」一眼可见
import { ensureDir, launch, queryUrl, screenshot, waitResult } from './harness.mjs';

ensureDir();
const { browser, page, errors } = await launch();
try {
  // 数采近 30 天 × 采集员：行数远超 50，用来演示「已截断 + 放宽上限」
  const url = queryUrl({
    ds: 'robot_collection',
    dims: 'date,collector',
    metrics: 'episodes,valid_episodes,total_hours',
    limit: 50,
  });
  await page.goto(url, { waitUntil: 'networkidle' });
  await waitResult(page);
  await screenshot(page, 'v11-概览条-截断与放宽');

  // 概览条 + 表格上半部分特写
  await screenshot(page, 'v11-概览条特写', { clip: { x: 480, y: 60, width: 1100, height: 330 } });

  // 点「放宽到 5000」：按钮直接带着新上限重查一次，不用用户再点一次查数
  await page.getByRole('button', { name: /放宽到 5000/ }).click();
  await page.waitForTimeout(2500);
  await waitResult(page);
  await screenshot(page, 'v11-放宽上限后不再截断');

  // 汇总口径：只有一行，合计就是它本身，顺带覆盖区间的识别
  await page.goto(
    queryUrl({ ds: 'robot_collection', dims: '', metrics: 'episodes,valid_episodes,total_hours,valid_rate' }),
    { waitUntil: 'networkidle' },
  );
  await waitResult(page);
  await screenshot(page, 'v11-汇总口径-概览条');
} finally {
  if (errors.length) console.log('控制台异常：', errors.slice(0, 5));
  await browser.close();
}
