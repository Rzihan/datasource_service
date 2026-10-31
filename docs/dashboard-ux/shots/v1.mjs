// v1 指标卡：趋势小图 + 环比 + 大数缩写
import { launch, enterAs, shot, BASE } from './harness.mjs';

const { browser, page, errors } = await launch();
await enterAs(page, 'alice');

await page.goto(`${BASE}/d/collect-overview`, { waitUntil: 'networkidle' });
await page.waitForTimeout(3000);
await shot(page, 'v1-指标卡带趋势与环比');

// 指标行特写
const row = page.locator('.ant-row').first();
await row.screenshot({ path: 'v1-指标行特写.png' }).catch(() => {});
console.log('  → v1-指标行特写.png');

if (errors.length) console.log('PAGE ERRORS:', errors.slice(0, 5));
await browser.close();
