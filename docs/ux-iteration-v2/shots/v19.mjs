// v19：数据集体检卡 —— 交出去的数据集，用户得先知道它能不能信
import { ensureDir, launch, queryUrl, screenshot, shotCard, waitResult } from './harness.mjs';

ensureDir();
const { browser, page, errors } = await launch();

// 体检卡是异步扫的（count 全表），等它出数再截
const waitStats = async () => {
  await page.getByText('数据行数').first().waitFor({ timeout: 25000 });
  await page.waitForTimeout(500);
  await page.getByText(/^\d+(\.\d+)?\s*(万|亿)?$/).first().waitFor({ timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(900);
};

try {
  // ① 144 万行 / 30 天 / 有负责人 / 有更新频率：这一栏就是「敢不敢用」的依据
  await page.goto(queryUrl({ ds: 'robot_pipeline', dims: 'date', metrics: 'tasks', limit: 1000 }), {
    waitUntil: 'networkidle',
  });
  await waitResult(page);
  await waitStats();
  await shotCard(page, 'v19-体检卡-144万行30天有负责人');

  // ② 换数据集，体检卡跟着换：90 万行 + 多值维度 1 个
  // 顶栏也有下拉（租户选择），必须限定在查询构建器卡片里
  await page.locator('.ant-card').filter({ hasText: '查询构建器' }).locator('.ant-select').first().click();
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').waitFor({ timeout: 10000 });
  await page.waitForTimeout(400);
  await page
    .locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')
    .filter({ hasText: 'robot_annotation' })
    .first()
    .click();
  await waitStats();
  await shotCard(page, 'v19-切换数据集-体检卡跟着换');

  // ③ 没写说明书的数据集：负责人/频率直接显示「未填写」，一眼看出该找作者补
  await page.goto(queryUrl({ ds: 'demo_tmpl', dims: 'city_tier', metrics: 'uv', limit: 1000 }), {
    waitUntil: 'networkidle',
  });
  await waitResult(page);
  await waitStats();
  await shotCard(page, 'v19-没写说明书的数据集-未填写');

  // ④ 新鲜度告警：标注「每日」更新，但数据只到 12 天前
  await page.goto(queryUrl({ ds: 'demo_order', dims: 'channel', metrics: 'cost', limit: 1000 }), {
    waitUntil: 'networkidle',
  });
  await waitResult(page);
  await waitStats();
  await shotCard(page, 'v19-数据可能滞后-新鲜度告警');
} finally {
  if (errors.length) console.log('控制台异常：', errors.slice(0, 5));
  await browser.close();
}
