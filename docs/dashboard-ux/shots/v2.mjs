// v2 图表可读性：饼图标签收敛 + 柱状图数值标签
import { launch, enterAs, shot, BASE } from './harness.mjs';

const { browser, page, errors } = await launch();
await enterAs(page, 'alice');

// 质检日报的「缺陷类型分布」是类目最多的饼图，最能看出标签打架
await page.goto(`${BASE}/d/qc-daily`, { waitUntil: 'networkidle' });
await page.waitForTimeout(3000);
await shot(page, 'v2-质检日报-饼图标签收敛');

// 采集日报：饼图 + 柱状图数值标签都在这屏
await page.goto(`${BASE}/d/collect-overview`, { waitUntil: 'networkidle' });
await page.waitForTimeout(3000);
await shot(page, 'v2-采集日报-柱状图数值标签');

if (errors.length) console.log('PAGE ERRORS:', errors.slice(0, 5));
await browser.close();
