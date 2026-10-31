// 手册补图：数据集编辑抽屉（收口 SQL + 三级权限配置）
import { launch, enterAs, shot, BASE } from './harness.mjs';

const { browser, page, errors } = await launch();
await enterAs(page, 'alice');
await page.goto(`${BASE}/datasets`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);

// 点第一行的「编辑」，打开数据集编辑抽屉
const editBtn = page.locator('button:has-text("编辑")').first();
await editBtn.click();
await page.waitForTimeout(2500); // Monaco 加载
await shot(page, 'manual-数据集编辑');
console.log('  → manual-数据集编辑');

// 抽屉截图（本体）
const drawer = page.locator('.ant-drawer-content').first();
await drawer.screenshot({ path: 'manual-数据集编辑-本体.png' }).catch(() => {});
console.log('  → manual-数据集编辑-本体');

if (errors.length) console.log('PAGE ERRORS:', errors.slice(0, 5));
await browser.close();
