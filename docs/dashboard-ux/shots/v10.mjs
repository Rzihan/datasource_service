// v10 相对窗口的「含今天」开关：半截的今天会拉低环比，要完整天可切「到昨天」
// 1) 默认「含今天」勾着，窗口到今天
// 2) 取消勾选 → 窗口止于昨天，面板口径日期后移一天
// 3) 切「近 30 天」→ 完整天偏好保留；刷新后也保留
import { launch, enterAs, shot, BASE } from './harness.mjs';

const { browser, page, errors } = await launch();
await enterAs(page, 'alice');
await page.goto(`${BASE}/d/collect-overview`, { waitUntil: 'networkidle' });
await page.waitForTimeout(3000);

const bar = page.locator('.ant-card', { hasText: '整屏筛选' }).first();
// 面板底部口径行（含「日期 X~Y」）随便取一块趋势面板
const trendCard = page.locator('.ant-card', { hasText: '每日采集条数趋势' }).first();
const footOf = () => trendCard.locator('..').locator('..').textContent();

console.log('  含今天勾选:', await bar.locator('.ant-checkbox-wrapper input').isChecked());
await bar.screenshot({ path: 'v10-含今天默认.png' }).catch(() => {});
const foot1 = await trendCard.textContent();
console.log('  默认口径含:', (foot1.match(/日期 [\d~-]+/) || ['?'])[0]);

// 取消「含今天」→ 到昨天
await bar.getByText('含今天', { exact: true }).click();
await page.waitForTimeout(2600);
console.log('  取消后勾选:', await bar.locator('.ant-checkbox-wrapper input').isChecked());
console.log('  localStorage:', await page.evaluate(() => localStorage.getItem('dashboard:dateMode')));
const foot2 = await trendCard.textContent();
console.log('  取消后口径含:', (foot2.match(/日期 [\d~-]+/) || ['?'])[0]);
await bar.screenshot({ path: 'v10-到昨天.png' }).catch(() => {});
await shot(page, 'v10-完整天整屏');

// 切近 30 天：完整天偏好保留
await page.getByText('近 30 天', { exact: true }).first().click();
await page.waitForTimeout(2400);
console.log('  切预设后勾选:', await bar.locator('.ant-checkbox-wrapper input').isChecked());
console.log('  切预设后 localStorage:', await page.evaluate(() => localStorage.getItem('dashboard:dateMode')));
await bar.screenshot({ path: 'v10-切预设仍保持.png' }).catch(() => {});

// 刷新后仍保留
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(2800);
const bar2 = page.locator('.ant-card', { hasText: '整屏筛选' }).first();
console.log('  刷新后勾选:', await bar2.locator('.ant-checkbox-wrapper input').isChecked());

if (errors.length) console.log('PAGE ERRORS:', errors.slice(0, 5));
await browser.close();
