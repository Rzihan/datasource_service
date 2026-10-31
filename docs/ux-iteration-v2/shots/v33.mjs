import { launch, screenshot, waitResult } from './harness.mjs';

// v33：大盘挂到旧菜单下。旧页面大多是大盘形态，
// 那种页面只能由一张大盘来替代——所以大盘必须和查询入口一样能挂在原菜单位置。
const { browser, page } = await launch();

// 1) 菜单：同一个菜单位置，按入口形态与迁移状态长成不同样子
await page.goto('http://localhost:5173/query', { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);
for (const m of ['数据采集', '数据标注', '质量检验', '商务交付', '运营管理']) {
  await page.locator('.ant-menu-submenu-title').filter({ hasText: m }).click();
  await page.waitForTimeout(300);
}
await screenshot(page, 'v33-菜单里-大盘与单表入口各归其位');

// 2) 旧页上的引导：这一页对位的是大盘，提示就要说清楚
await page.goto('http://localhost:5173/legacy/collect_daily', { waitUntil: 'networkidle' });
await page.waitForTimeout(1000);
await screenshot(page, 'v33-旧页面上的引导-这一页对位的是大盘');

// 3) 从旧版过来：先把对照摆出来，那一屏是不是「原来那页」一眼可判
await page.locator('.ant-alert button').filter({ hasText: '立即体验' }).first().click();
await page.waitForTimeout(4500);
await screenshot(page, 'v33-从旧版过来-先讲清这一屏替代了哪一页', { fullPage: true });

// 4) 迁移看板：大盘也是迁移目标，不记进去就会低估迁移率
await page.goto('http://localhost:5173/migration', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
await screenshot(page, 'v33-迁移看板-区分大盘与单表入口');

await browser.close();
console.log('v33 shots done');
