import { launch, screenshot } from './harness.mjs';

// v31：一次可视化查询只能替代大盘页里的「一块」，替代不了整个页面。
// 所以单位要升级：面板 = 一次查询 + 怎么呈现，大盘 = 一组面板。
const { browser, page } = await launch();

// 1) 大盘列表
await page.goto('http://localhost:5173/dashboards', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
await screenshot(page, 'v31-大盘列表-一屏多面板');

// 2) 采集日报大盘：上面指标卡、中间趋势、下面明细——旧大盘页的形状
await page.goto('http://localhost:5173/d/collect-overview', { waitUntil: 'networkidle' });
await page.waitForTimeout(4000);
await screenshot(page, 'v31-采集日报大盘-上面指标中间趋势下面明细', { fullPage: true });

// 3) 面板各自的形态：柱状 / 饼图 / 明细表
await page.goto('http://localhost:5173/d/anno-board', { waitUntil: 'networkidle' });
await page.waitForTimeout(3500);
await screenshot(page, 'v31-标注产能大盘-面板各自是一种形态', { fullPage: true });

await browser.close();
console.log('v31 shots done');
