import { launch, screenshot } from './harness.mjs';

// v35：一屏八块之后，可靠性就变成第一位的——
// 只给一个整屏 loading，任何一块慢都会让整屏看起来卡住；任何一块挂了只会沉默地空着。
const { browser, page, context } = await launch();
// 允许下载：导出整屏是这一版的主角之一
await context.grantPermissions([]).catch(() => {});

// 1) 顶部汇总「几块就绪」+ 每块自己的行数/耗时/口径
await page.goto('http://localhost:5173/d/collect-overview', { waitUntil: 'networkidle' });
await page.waitForTimeout(5000);
await screenshot(page, 'v35-顶部汇总几块就绪-每块带自己的口径', { fullPage: true });

// 2) 收窄之后再看：截断与筛选都要写在脸上
const bar = page.locator('.ant-card').first();
await bar.locator('.ant-select').first().click();
await page.waitForTimeout(600);
await page.locator('.ant-select-item-option').nth(1).click();
await page.waitForTimeout(4500);
await screenshot(page, 'v35-收窄后每块都写明自己被筛过', { fullPage: true });

// 3) 自动刷新：看板是挂着看的，但默认必须关
await page.locator('.ant-select').filter({ hasText: '不自动刷新' }).first().click();
await page.waitForTimeout(500);
await page.locator('.ant-select-item-option').filter({ hasText: '每 1 分钟' }).first().click();
await page.waitForTimeout(600);
await screenshot(page, 'v35-自动刷新与更新时间');

// 4) 导出整屏：一个文件，按面板分段，各带口径
const [download] = await Promise.all([
  page.waitForEvent('download', { timeout: 15000 }).catch(() => null),
  page.locator('button').filter({ hasText: '导出整屏' }).first().click(),
]);
if (download) {
  const path = await download.path();
  console.log('downloaded:', download.suggestedFilename(), path);
}
await page.waitForTimeout(600);
await screenshot(page, 'v35-导出整屏-按面板分段各带口径');

await browser.close();
console.log('v35 shots done');
