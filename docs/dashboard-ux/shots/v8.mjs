// v8 整屏状态进 URL：筛选、下钻链、时间模式都跟着链接走
// 1) 造状态：点柱下钻 + 选团队筛选 + 切近 30 天
// 2) 看地址栏：状态已写进 URL
// 3) 重新打开同一链接（模拟同事收到）→ 还原同一屏
import { launch, enterAs, shot, BASE } from './harness.mjs';

const { browser, page, errors } = await launch();
await enterAs(page, 'alice');
await page.goto(`${BASE}/d/collect-overview`, { waitUntil: 'networkidle' });
await page.waitForTimeout(3000);

// ── 1. 造状态：下钻 + 筛选 + 时间 ────────────────────────────────
// 在「场景分布」饼图上点一块 → 下钻链（scene 字段，与下面的团队筛选不冲突）。
// 饼的圆心不在 canvas 中心：图例占了顶部，圆心大约在 0.64 高度处（v3 的经验）。
const pie = await page.evaluate(() => {
  const cs = [...document.querySelectorAll('canvas')].map((c) => {
    const r = c.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  return cs[cs.length - 1];
});
const cx = pie.x + pie.w / 2;
const cy = pie.y + pie.h * 0.64;
const drillTag = page.locator('.ant-tag').filter({ hasText: '=' });
outer: for (const [dx, dy] of [
  [0, 0],
  [34, 0],
  [-34, 0],
  [0, -30],
  [24, 24],
  [40, 18],
]) {
  await page.mouse.click(cx + dx, cy + dy);
  await page.waitForTimeout(1100);
  if ((await drillTag.count()) > 0) break outer;
}
console.log('  下钻链出现:', (await drillTag.count()) > 0);

// 顶部筛选选团队
const sel = page.locator('.ant-select', { hasText: '团队' }).first();
await sel.click();
await page.waitForTimeout(500);
await page.locator('.ant-select-item-option', { hasText: '采集一组' }).first().click();
await page.waitForTimeout(2200);

// 时间切近 30 天
await page.getByText('近 30 天', { exact: true }).first().click();
await page.waitForTimeout(2600);

const url = page.url();
console.log('  地址栏:', decodeURIComponent(url));
await shot(page, 'v8-造好的状态');

// ── 2. 重新打开同一链接（模拟同事收到） ──────────────────────────
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForTimeout(3200);
const bar2 = page.locator('.ant-card', { hasText: '整屏筛选' }).first();
const selected = await bar2.locator('.ant-segmented-item-selected').textContent();
console.log('  还原后时间模式:', selected);
console.log('  还原后下钻链 tag 数:', await page.locator('.ant-tag', { hasText: '=' }).count());
console.log('  还原后团队筛选值:', await bar2.locator('.ant-select-selection-item').first().textContent());
await shot(page, 'v8-链接打开还原同屏');

// ── 3. 复制链接按钮 ──────────────────────────────────────────────
await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
await page.getByText('复制链接', { exact: true }).first().click();
await page.waitForTimeout(600);
await shot(page, 'v8-复制链接提示');

if (errors.length) console.log('PAGE ERRORS:', errors.slice(0, 5));
await browser.close();
