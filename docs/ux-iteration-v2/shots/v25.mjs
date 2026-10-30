// v25：作者不再靠「堆十条预置」表达意图 —— 在看板里存一条，并指定哪条是默认
import { ensureDir, launch, queryUrl, screenshot, shotCard, waitResult } from './harness.mjs';

ensureDir();
const { browser, page, errors } = await launch();

const builder = () => page.locator('.ant-card').filter({ hasText: '查询构建器' });

try {
  // ① 作者在看板里调好一张图（带筛选 + 排序），右上角「存为预置分析」
  await page.goto(
    queryUrl({
      ds: 'robot_qc',
      dims: 'defect_type',
      metrics: 'defects',
      order: 'defects',
      dir: 'desc',
      limit: 1000,
    }),
    { waitUntil: 'networkidle' },
  );
  await waitResult(page);
  await page.waitForTimeout(1200);
  await shotCard(page, 'v25-结果卡右上角的作者入口', '.ant-card >> nth=1');

  await page.locator('button').filter({ hasText: '存为预置分析' }).click();
  await page.waitForSelector('.ant-modal-content');
  await page.waitForTimeout(500);
  await page.locator('.ant-modal-content input').first().fill('缺陷 TOP（按缺陷数降序）');
  await page.locator('.ant-modal-content textarea').first().fill('日常巡检第一屏：只看哪类缺陷最多');
  await page.waitForTimeout(300);
  await screenshot(page, 'v25-把当前这一屏存为预置分析');
  await page.locator('.ant-modal-footer .ant-btn-primary').click();
  await page.waitForTimeout(2000);

  // ② 存完立刻出现在数据集的预置列表里，并标为「作者默认」
  await page.waitForTimeout(800);
  await shotCard(page, 'v25-存完立刻出现在预置列表并标为作者默认');

  // ③ 配置页里能改说明书：描述 / 负责人 / 更新频率 / 标签 / 字段口径 / 默认视图
  await page.goto(`${'http://localhost:5173'}/datasets`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await page.getByPlaceholder('按 key 或名称搜索').fill('robot_qc');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);
  await page.locator('.ant-table-tbody').getByText('编辑', { exact: true }).first().click();
  await page.waitForSelector('.ant-drawer-content');
  await page.waitForTimeout(900);
  await page.locator('.ant-drawer').getByText('说明书（meta）').click();
  await page.waitForTimeout(900);
  await page.locator('.ant-drawer-content').screenshot({
    path: new URL('./v25-配置页可以写说明书了.png', import.meta.url).pathname,
  });
  console.log('  → v25-配置页可以写说明书了.png');

  // ④ 只带 ds 打开：用户没设默认收藏时，跑作者的默认视图
  await page.goto(queryUrl({ ds: 'robot_qc', limit: 1000 }), { waitUntil: 'networkidle' });
  await waitResult(page);
  await page.waitForTimeout(1500);
  await screenshot(page, 'v25-打开数据集直接是作者的默认视图');
} finally {
  if (errors.length) console.log('控制台异常：', errors.slice(0, 5));
  await browser.close();
}
