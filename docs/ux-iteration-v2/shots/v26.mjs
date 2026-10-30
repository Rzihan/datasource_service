// v26：可视化查询不再只有一个入口 —— 数据集可以挂到旧页面菜单下面
import { ensureDir, launch, screenshot } from './harness.mjs';

ensureDir();
const { browser, page, errors } = await launch();

try {
  // ① 菜单里长出了可视化查询版：挂在原页面下面，不用先去查询页找
  await page.goto('http://localhost:5173/query', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await page.locator('.ant-menu-submenu-title').filter({ hasText: '数据采集' }).click();
  await page.waitForTimeout(600);
  await page.locator('.ant-menu-submenu-title').filter({ hasText: '数据标注' }).click();
  await page.waitForTimeout(600);
  await screenshot(page, 'v26-旧菜单下面长出可视化查询版');

  // ② 入口页：数据集由入口固定，查询能力照旧
  await page.goto('http://localhost:5173/e/collect-daily', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  await screenshot(page, 'v26-入口页-数据集已固定');

  // ③ 旧页面还在，上面能看到自己被哪个入口替代了
  await page.goto('http://localhost:5173/legacy/collect_daily', { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await screenshot(page, 'v26-存量页面与迁移状态');
} finally {
  if (errors.length) console.log('PAGE ERRORS:', errors.slice(0, 5));
  await browser.close();
}
