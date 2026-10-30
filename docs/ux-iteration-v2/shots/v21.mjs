// v21：界面档位 —— 同一个看板，新手要引导，老手要安静
import { ensureDir, launch, queryUrl, screenshot, shotCard, waitResult } from './harness.mjs';

ensureDir();
const { browser, page, errors } = await launch();

// Segmented 的两字标签也可能被 antd 插空格，用 CSS 定位
const setDensity = async (label) => {
  await page.locator('.ant-segmented-item').filter({ hasText: label }).click();
  await page.waitForTimeout(1000);
};

const url = { ds: 'robot_collection', dims: 'date', metrics: 'episodes,valid_rate', limit: 1000 };

try {
  // ① 完整档（默认）：预置分析、口径说明、趋势线、推荐提示全在
  await page.goto(queryUrl(url), { waitUntil: 'networkidle' });
  await waitResult(page);
  await page.getByText('数据行数').first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(1500);
  await screenshot(page, 'v21-完整档-引导全开');

  // ② 切简洁档：同一张查询，教学性内容全部收起
  await setDensity('简洁');
  await waitResult(page);
  await page.waitForTimeout(1200);
  await screenshot(page, 'v21-简洁档-只留核心');
  await shotCard(page, 'v21-简洁档-左栏卡片特写');

  // ③ 字段下拉：简洁档只显示名字，但搜索仍命中口径说明
  await page.locator('.ant-card').filter({ hasText: '查询构建器' }).locator('.ant-select').nth(1).click();
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').waitFor({ timeout: 10000 });
  await page.waitForTimeout(500);
  await screenshot(page, 'v21-简洁档-字段下拉只有名字');
  await page.keyboard.press('Escape');

  // ④ 收起不等于删掉：点「展开」预置分析还在
  await page.waitForTimeout(400);
  await page.locator('.ant-card').filter({ hasText: '查询构建器' }).getByText('展开', { exact: true }).click();
  await page.waitForTimeout(600);
  await shotCard(page, 'v21-简洁档-预置收起但可展开');

  // ⑤ 档位是全局偏好，刷新后仍然是简洁档
  await page.reload({ waitUntil: 'networkidle' });
  await waitResult(page);
  await page.waitForTimeout(1200);
  await page.locator('.ant-layout-header').screenshot({
    path: new URL('./v21-档位开关在顶栏.png', import.meta.url).pathname,
  });
  console.log('  → v21-档位开关在顶栏.png');
  await screenshot(page, 'v21-简洁档-刷新后仍保持');
} finally {
  if (errors.length) console.log('控制台异常：', errors.slice(0, 5));
  await browser.close();
}
