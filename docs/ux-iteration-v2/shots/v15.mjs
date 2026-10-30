// v15：字段选择器 —— 几十个字段不分组、没有搜索、不知道口径
import { ensureDir, launch, queryUrl, screenshot, waitResult } from './harness.mjs';

ensureDir();
const { browser, page, errors } = await launch();

try {
  // 商务数据集字段最多（13 个维度 + 15 个指标），最能体现「找不到」
  await page.goto(queryUrl({ ds: 'robot_business', dims: 'tier', metrics: 'revenue' }), {
    waitUntil: 'networkidle',
  });
  await waitResult(page);
  await screenshot(page, 'v15-数据集说明与字段入口');

  // 打开指标下拉：分组标题 + 每个字段的口径说明
  const selects = page.locator('.ant-card .ant-select');
  // 第 1 个是数据集，第 2 个维度，第 3 个指标
  await selects.nth(2).click();
  await page.waitForTimeout(800);
  // 下拉会自动滚到已选项，滚回顶部才能看见分组标题
  await page.mouse.move(280, 400);
  await page.mouse.wheel(0, -900);
  await page.waitForTimeout(500);
  await screenshot(page, 'v15-指标下拉-分组与口径');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // 按口径搜索：用户记得「不含税」，但记不住字段叫 revenue
  await selects.nth(2).click();
  await page.keyboard.type('不含税');
  await page.waitForTimeout(800);
  await screenshot(page, 'v15-按口径搜索命中');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // 维度下拉的分组：普通维度 vs 多值维度
  await page.goto(queryUrl({ ds: 'robot_annotation', dims: 'annotator', metrics: 'units' }), {
    waitUntil: 'networkidle',
  });
  await waitResult(page);
  const selects2 = page.locator('.ant-card .ant-select');
  await selects2.nth(1).click();
  await page.waitForTimeout(800);
  // 普通维度有 12 个，多值维度在下面，滚到底才能看到第二个分组
  await page.mouse.move(280, 400);
  await page.mouse.wheel(0, 1150);
  await page.waitForTimeout(600);
  await screenshot(page, 'v15-维度下拉-多值维度单独分组');
} finally {
  if (errors.length) console.log('控制台异常：', errors.slice(0, 5));
  await browser.close();
}
