// 产品手册配图：登录、配置管理、字段字典、查询页（结果/收藏夹/历史）、旧版对照
import { launch, enterAs, shot, BASE } from './harness.mjs';

const { browser, page, errors } = await launch();

// ── 登录页（未登录状态） ─────────────────────────────────────────
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
await shot(page, 'manual-登录');
console.log('  → manual-登录');

await enterAs(page, 'alice');

// ── 数据集管理 ───────────────────────────────────────────────────
await page.goto(`${BASE}/datasets`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);
await shot(page, 'manual-数据集管理');
console.log('  → manual-数据集管理');

// ── 字段字典 ─────────────────────────────────────────────────────
await page.goto(`${BASE}/labels`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);
await shot(page, 'manual-字段字典');
console.log('  → manual-字段字典');

// ── 查询页：结果态 ───────────────────────────────────────────────
await page.goto(`${BASE}/query?ds=robot_collection&dims=scene&metrics=episodes&order=episodes&dir=desc&limit=20`, { waitUntil: 'networkidle' });
await page.waitForTimeout(3200);
await shot(page, 'manual-查询页结果');
console.log('  → manual-查询页结果');

// 收藏夹抽屉
await page.getByText('收藏夹', { exact: true }).first().click();
await page.waitForTimeout(1000);
await shot(page, 'manual-收藏夹');
console.log('  → manual-收藏夹');
await page.keyboard.press('Escape');
await page.waitForTimeout(500);

// 历史抽屉
await page.getByText('历史', { exact: true }).first().click();
await page.waitForTimeout(1000);
await shot(page, 'manual-查询历史');
console.log('  → manual-查询历史');
await page.keyboard.press('Escape');

// ── 旧版对照页 ───────────────────────────────────────────────────
await page.goto(`${BASE}/legacy/collect_daily`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);
await shot(page, 'manual-旧版对照');
console.log('  → manual-旧版对照');

if (errors.length) console.log('PAGE ERRORS:', errors.slice(0, 5));
await browser.close();
