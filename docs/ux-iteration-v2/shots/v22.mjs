// v22：默认视图 —— 老手的问题不是「找不到」，是「每天都得点一次」
import { ensureDir, launch, queryUrl, screenshot, shotCard, waitResult } from './harness.mjs';

ensureDir();
const { browser, page, errors } = await launch();

const saveWithDefault = async (name) => {
  await page.locator('.ant-card-extra button').filter({ hasText: /^收藏$/ }).click();
  await page.waitForSelector('.ant-modal-content');
  await page.waitForTimeout(400);
  await page.locator('.ant-modal-content input').first().fill(name);
  await page.waitForTimeout(200);
  await screenshot(page, 'v22-收藏时可设为默认视图');
  await page.locator('.ant-modal-footer .ant-btn-primary').click();
  await page.waitForTimeout(1000);
};

try {
  // ① 收藏时就能钉死：这个数据集以后就按这条看
  await page.goto(
    queryUrl({ ds: 'robot_collection', dims: 'scene', metrics: 'episodes,valid_rate', limit: 1000 }),
    { waitUntil: 'networkidle' },
  );
  await waitResult(page);
  await page.waitForTimeout(600);
  await saveWithDefault('各场景产出（我每周看这个）');

  // ② 结果区标出「默认视图」，并且能当场取消
  await screenshot(page, 'v22-结果区标出默认视图');

  // ③ 切走再切回来：不用点任何东西，直接就是那条
  await page.locator('.ant-card').filter({ hasText: '查询构建器' }).locator('.ant-select').first().click();
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').waitFor({ timeout: 10000 });
  await page
    .locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')
    .filter({ hasText: 'robot_annotation' })
    .first()
    .click();
  await page.waitForTimeout(1200);
  await page.locator('.ant-card').filter({ hasText: '查询构建器' }).locator('.ant-select').first().click();
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').waitFor({ timeout: 10000 });
  await page
    .locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')
    .filter({ hasText: 'robot_collection' })
    .first()
    .click();
  await waitResult(page);
  await page.waitForTimeout(1200);
  await screenshot(page, 'v22-切回数据集自动跑默认视图');

  // ④ 收藏夹里：默认视图排最前，可置顶、可取消默认
  await page.locator('.ant-card-extra button').filter({ hasText: /^收藏夹/ }).click();
  await page.waitForSelector('.ant-drawer-content');
  await page.waitForTimeout(700);
  await shotCard(page, 'v22-收藏夹-默认视图排最前', '.ant-drawer-content');

  // ⑤ 直接带着链接进来时，链接优先于默认视图——分享出去的链接必须能还原
  await page.goto(
    queryUrl({ ds: 'robot_collection', dims: 'date', metrics: 'episodes', limit: 1000 }),
    { waitUntil: 'networkidle' },
  );
  await waitResult(page);
  await page.waitForTimeout(1200);
  await screenshot(page, 'v22-链接优先于默认视图');
} finally {
  if (errors.length) console.log('控制台异常：', errors.slice(0, 5));
  await browser.close();
}
