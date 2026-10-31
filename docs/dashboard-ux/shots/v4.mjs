// v4 大盘级时间范围：打开预设、选「近 7 天」，整屏收窄
import { launch, enterAs, shot, BASE } from './harness.mjs';

const { browser, page, errors } = await launch();
await enterAs(page, 'alice');
await page.goto(`${BASE}/d/collect-overview`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);

// 打开时间范围，露出预设（近 7 / 14 / 30 天）
await page.locator('.ant-picker').first().click();
await page.waitForTimeout(600);
await shot(page, 'v4-时间范围-预设下拉');

// 选近 7 天
await page.locator('.ant-picker-dropdown').getByText('近 7 天').first().click();
await page.waitForTimeout(3200);
await shot(page, 'v4-近7天-整屏收窄');

// 筛选条特写（时间范围 + 跟随提示）
const bar = page.locator('.ant-card').filter({ hasText: '整屏筛选' }).first();
await bar.screenshot({ path: 'v4-时间范围特写.png' }).catch(() => {});
console.log('  → v4-时间范围特写.png');

if (errors.length) console.log('PAGE ERRORS:', errors.slice(0, 5));
await browser.close();
