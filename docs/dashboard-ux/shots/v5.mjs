// v5 面板聚焦放大 + 布局密度
// 1) 点「放大这一块」→ 弹层里大尺寸重画同一块，并给「在查询页打开」深链
// 2) 顶栏密度切到「紧凑」→ 一屏更密；切回「舒适」对照
import { launch, enterAs, shot, BASE } from './harness.mjs';

const { browser, page, errors } = await launch();
await enterAs(page, 'alice');
await page.goto(`${BASE}/d/collect-overview`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2800);

// ── 1. 放大面板弹层 ──────────────────────────────────────────────
// 取「场景分布」那块饼图，点右上角放大按钮（卡片 extra 里的唯一 text 按钮）。
const card = page.locator('.ant-card', { hasText: '场景分布' }).first();
await card.locator('.ant-card-extra button.ant-btn-text').first().click();
await page.waitForSelector('.ant-modal-content', { timeout: 8000 });
await page.waitForTimeout(2800);
await shot(page, 'v5-放大面板弹层');
// 只截弹层本体，看得更清
await page.locator('.ant-modal').screenshot({ path: 'v5-放大面板弹层-本体.png' }).catch(() => {});
console.log('  → v5-放大面板弹层-本体.png');

// 弹层里的「在查询页打开」→ 跳到查询页，且 URL 带 ds / dims / filter
await page.locator('.ant-modal-footer').getByText('在查询页打开').click();
await page.waitForTimeout(2500);
const url = page.url();
console.log('  跳转 URL:', url);
await shot(page, 'v5-在查询页打开-深链');
await page.goto(`${BASE}/d/collect-overview`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2600);

// ── 2. 布局密度 ──────────────────────────────────────────────────
// 切到「紧凑」：一屏能多看几块
await page.getByText('紧凑', { exact: true }).first().click();
await page.waitForTimeout(800);
await shot(page, 'v5-密度-紧凑');

// 切回「舒适」对照
await page.getByText('舒适', { exact: true }).first().click();
await page.waitForTimeout(800);
await shot(page, 'v5-密度-舒适');

if (errors.length) console.log('PAGE ERRORS:', errors.slice(0, 5));
await browser.close();
