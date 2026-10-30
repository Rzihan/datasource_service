// v24：结果表格给老手让路 —— 列显隐 + 行高密度，横向滚动不再是唯一选择
import { ensureDir, launch, queryUrl, screenshot, shotCard, waitResult } from './harness.mjs';

ensureDir();
const { browser, page, errors } = await launch();

// 16 个维度的数据集查出来列很多：老手只想看其中三列
const url = {
  ds: 'robot_collection',
  dims: 'team,collector,city',
  metrics: 'episodes,valid_rate,avg_quality,avg_duration',
  limit: 1000,
};

try {
  await page.goto(queryUrl(url), { waitUntil: 'networkidle' });
  await waitResult(page);
  await page.waitForTimeout(1500);
  await shotCard(page, 'v24-列名太多-横向滚动', '.ant-card');
  await screenshot(page, 'v24-默认-宽松行高');

  // ① 列显隐：把不关心的四列关掉
  await page.locator('button').filter({ hasText: /^列 \d+\/\d+/ }).click();
  await page.waitForTimeout(600);
  await screenshot(page, 'v24-列显隐面板');
  for (const name of ['avg_duration', 'avg_quality', 'city']) {
    await page.locator('.ant-dropdown:not(.ant-dropdown-hidden) label').filter({ hasText: name }).first().click();
    await page.waitForTimeout(250);
  }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(700);
  await shotCard(page, 'v24-隐藏三列后-表格不再需要横向滚动', '.ant-card');

  // ② 紧凑行高：一屏多看一倍行
  await page.locator('button').filter({ hasText: '紧凑行高' }).click();
  await page.waitForTimeout(900);
  await screenshot(page, 'v24-紧凑行高-一屏多看一倍');

  // ③ 隐藏的列仍进 CSV：藏是为了看，不是为了改数据
  await shotCard(page, 'v24-隐藏的列仍写进CSV', '.ant-card');
} finally {
  if (errors.length) console.log('控制台异常：', errors.slice(0, 5));
  await browser.close();
}
