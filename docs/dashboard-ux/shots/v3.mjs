// v3 下钻链：点柱状图 → 点饼图，形成「团队 → 场景」两步链，可单步回退
import { launch, enterAs, shot, BASE } from './harness.mjs';

const { browser, page, errors } = await launch();
await enterAs(page, 'alice');
await page.goto(`${BASE}/d/collect-overview`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);

const hasChain = async () => (await page.locator('text=下钻链').count()) > 0;

// 柱状图：canvas 在左下 (x≈241,y≈806,w≈648,h≈188)。绘图区左边留了 ~50px 轴标签，
// 6 个柱子的中心大致在 340/438/536/634/732/830。柱身很窄，必须点中心。
outer: for (const x of [340, 438, 536, 634, 732, 830]) {
  for (const y of [920, 935, 905]) {
    await page.mouse.click(x, y);
    await page.waitForTimeout(500);
    if (await hasChain()) break outer;
  }
}
console.log('step1 chain:', await hasChain());
await page.waitForTimeout(1500);

// 饼图：第一步筛选后图例会变（类目变少），饼的位置会跟着动，
// 所以重新量一次 canvas；再以圆心为基准点几个偏移位置命中扇区。
if (await page.locator('text=下钻链').count()) {
  const pie = await page.evaluate(() => {
    const cs = [...document.querySelectorAll('canvas')].map((c) => {
      const r = c.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    return cs[cs.length - 1];
  });
  const cx = pie.x + pie.w / 2;
  const cy = pie.y + pie.h * 0.64;
  for (const [dx, dy] of [
    [0, 0],
    [34, 0],
    [-34, 0],
    [0, -30],
    [24, 24],
  ]) {
    await page.mouse.click(cx + dx, cy + dy);
    await page.waitForTimeout(600);
    // 只数「下钻链」里的 step chip（文本形如「团队 = 采集五组」）；
    // 别数 .ant-tag-blue——每个被筛到的面板都挂一个「已筛选」蓝标签。
    const chips = await page.locator('.ant-tag').filter({ hasText: '=' }).count();
    if (chips >= 2) break;
  }
}
await page.waitForTimeout(1800);
await shot(page, 'v3-下钻链两步');

// 下钻链区域特写
const card = page.locator('.ant-card').filter({ hasText: '整屏筛选' }).first();
await card.screenshot({ path: 'v3-下钻链特写.png' }).catch(() => {});
console.log('  → v3-下钻链特写.png');

if (errors.length) console.log('PAGE ERRORS:', errors.slice(0, 5));
await browser.close();
