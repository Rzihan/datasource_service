import { launch, screenshot, waitResult } from './harness.mjs';

// v34：大盘得能自己长出来。作者最自然的动作是
// 「在查询页调好一屏 → 加进大盘 → 再改改标题和宽窄」，不是去配置页手敲查询串。
const { browser, page } = await launch();

// 1) 在查询页调好一屏，然后「加入大盘」
await page.goto(
  'http://localhost:5173/query?ds=robot_collection&dims=team&metrics=episodes,valid_rate&order=episodes&dir=desc&limit=20',
  { waitUntil: 'networkidle' },
);
await waitResult(page);
await page.waitForTimeout(1500);
await page.locator('button').filter({ hasText: '加入大盘' }).first().click();
await page.waitForTimeout(800);
await screenshot(page, 'v34-查询页把这一屏加入大盘');

// 选一张已有大盘，改标题与形态后加入
await page.locator('.ant-modal .ant-select').first().click();
await page.waitForTimeout(500);
await page.locator('.ant-select-item-option').filter({ hasText: '标注产能看板' }).first().click();
await page.waitForTimeout(300);
await page.locator('.ant-modal input[placeholder*="这一块的标题"]').fill('各团队采集条数与有效率');
await page.locator('.ant-modal .ant-select').nth(1).click();
await page.waitForTimeout(400);
await page.locator('.ant-select-item-option').filter({ hasText: '柱状图' }).first().click();
await page.waitForTimeout(300);
await screenshot(page, 'v34-选大盘-改标题-选形态');
await page.locator('.ant-modal-footer button.ant-btn-primary').click();
await page.waitForTimeout(1500);
await screenshot(page, 'v34-加入后的提示');

// 2) 大盘页编辑态：改、删、加面板都在这一屏里
await page.goto('http://localhost:5173/d/anno-board', { waitUntil: 'networkidle' });
await page.waitForTimeout(4000);
await page.locator('button').filter({ hasText: '编辑' }).first().click();
await page.waitForTimeout(600);
await screenshot(page, 'v34-编辑态-每个面板都能改能删', { fullPage: true });

// 打开面板编辑器：改标题 / 视图 / 宽窄 / 是否跟随
const cards = page.locator('.ant-card');
for (let i = 0; i < (await cards.count()); i++) {
  const t = await cards.nth(i).innerText();
  if (t.includes('各类型产出')) {
    await cards.nth(i).locator('button').first().click();
    break;
  }
}
await page.waitForTimeout(900);
await screenshot(page, 'v34-面板编辑器-改查询改画法改宽窄');

await browser.close();
console.log('v34 shots done');
