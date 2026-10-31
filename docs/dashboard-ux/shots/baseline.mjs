// 基线截图：记录迭代前的仪表盘样子，作为后面每一版的对照。
import { launch, enterAs, shot, BASE } from './harness.mjs';

const { browser, page, errors } = await launch();

await enterAs(page, 'alice');

// 1) 采集任务日报（指标卡 + 趋势 + 柱状 + 饼 + 明细）
await page.goto(`${BASE}/d/collect-overview`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
await shot(page, 'baseline-采集任务日报');

// 2) 质检日报
await page.goto(`${BASE}/d/qc-daily`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
await shot(page, 'baseline-质检日报');

// 3) 标注产能看板
await page.goto(`${BASE}/d/anno-board`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
await shot(page, 'baseline-标注产能看板');

// 4) 点一个柱子下钻，看当前「筛选」的样子（扁平 tag）
await page.goto(`${BASE}/d/collect-overview`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
const bars = page.locator('.recharts-bar-rectangle').first();
if (await bars.count()) {
  await bars.click({ force: true });
  await page.waitForTimeout(1500);
  await shot(page, 'baseline-点柱下钻');
}

if (errors.length) console.log('PAGE ERRORS:', errors.slice(0, 5));
await browser.close();
