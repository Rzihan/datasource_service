// v9 仪表盘列表：最近打开 + 星标置顶
// 1) 清空痕迹 → 原始顺序
// 2) 打开「采集任务日报」→ 列表里它带「最近打开 今天 …」并排到前面
// 3) 给「标注产能看板」点星 → 置顶 + 「常用」标
import { launch, enterAs, shot, BASE } from './harness.mjs';

const { browser, page, errors } = await launch();
await enterAs(page, 'alice');

// 清掉本地使用痕迹，从头演示
await page.goto(`${BASE}/dashboards`, { waitUntil: 'networkidle' });
await page.evaluate(() => localStorage.removeItem('dashboard:usage'));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
console.log('  默认顺序:', (await page.locator('.ant-card-head-title').allTextContents()).join(' | '));
await shot(page, 'v9-列表默认');

// 打开采集任务日报再回来：应有「最近打开」并上浮
await page.goto(`${BASE}/d/collect-overview`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2200);
await page.goto(`${BASE}/dashboards`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
console.log('  打开后顺序:', (await page.locator('.ant-card-head-title').allTextContents()).join(' | '));
await shot(page, 'v9-最近打开上浮');

// 给「标注产能看板」点星 → 置顶
const annoCard = page.locator('.ant-card', { hasText: '标注产能看板' }).first();
await annoCard.locator('.ant-card-extra button').click();
await page.waitForTimeout(900);
console.log('  星标后顺序:', (await page.locator('.ant-card-head-title').allTextContents()).join(' | '));
await shot(page, 'v9-星标置顶');

// 刷新后星标仍在（localStorage）
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
console.log('  刷新后顺序:', (await page.locator('.ant-card-head-title').allTextContents()).join(' | '));

if (errors.length) console.log('PAGE ERRORS:', errors.slice(0, 5));
await browser.close();
