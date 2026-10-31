// v6 时间筛选改成「相对窗口」：默认近 7 天，每天打开/每次刷新都滚到今天
// 1) 打开大盘默认高亮「近 7 天」，取数窗口 = 到今天的 7 天
// 2) 切「近 30 天」→ 窗口立刻变宽
// 3) 刷新页面 → 仍记住「近 30 天」（localStorage）
// 4) 切「自定义」→ 出现固定区间选择器，不再滚动
import { launch, enterAs, shot, BASE } from './harness.mjs';

const { browser, page, errors } = await launch();
await enterAs(page, 'alice');
await page.goto(`${BASE}/d/collect-overview`, { waitUntil: 'networkidle' });
await page.waitForTimeout(3000);

const bar = page.locator('.ant-card', { hasText: '整屏筛选' }).first();
const modeOf = () => bar.locator('.ant-segmented-item-selected').textContent();

// ── 1. 默认就是「近 7 天」（相对窗口，自动滚动） ──────────────────
console.log('  默认时间模式:', await modeOf());
console.log('  localStorage:', await page.evaluate(() => localStorage.getItem('dashboard:dateMode')));
await shot(page, 'v6-默认近7天');
await bar.screenshot({ path: 'v6-时间模式特写.png' }).catch(() => {});
console.log('  → v6-时间模式特写.png');

// ── 2. 切「近 30 天」：窗口变宽，面板口径跟着变 ───────────────────
await page.getByText('近 30 天', { exact: true }).first().click();
await page.waitForTimeout(3000);
console.log('  切换后模式:', await modeOf());
console.log('  localStorage:', await page.evaluate(() => localStorage.getItem('dashboard:dateMode')));
await shot(page, 'v6-近30天');

// ── 3. 刷新后仍记住「近 30 天」，且窗口重新滚到今天 ───────────────
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(3000);
console.log('  刷新后模式:', await modeOf());
await bar.screenshot({ path: 'v6-刷新后仍记住近30天.png' }).catch(() => {});

// ── 4. 自定义 = 固定区间（不滚动），出现日期选择器 ────────────────
await page.getByText('自定义', { exact: true }).first().click();
await page.waitForTimeout(2400);
console.log('  切自定义后 localStorage:', await page.evaluate(() => localStorage.getItem('dashboard:dateMode')));
await bar.screenshot({ path: 'v6-自定义固定区间.png' }).catch(() => {});

if (errors.length) console.log('PAGE ERRORS:', errors.slice(0, 5));
await browser.close();
