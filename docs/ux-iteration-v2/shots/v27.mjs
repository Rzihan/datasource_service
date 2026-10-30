// v27：入口打开就该是用户熟悉的那张图 —— 不用再自己搭一遍
import { ensureDir, launch, screenshot, waitResult } from './harness.mjs';

ensureDir();
const { browser, page, errors } = await launch();

try {
  // ① 从旧菜单点进来，第一屏就是原来那张表的可视化版
  await page.goto('http://localhost:5173/e/collect-daily', { waitUntil: 'networkidle' });
  await waitResult(page);
  await page.waitForTimeout(1200);
  await screenshot(page, 'v27-入口打开就是原来那张表');

  // ② 头部：来自哪个旧页面、随时能退回旧版、也能去全部数据集
  await page.locator('.ant-layout-content > div > div').first().screenshot({
    path: new URL('./v27-入口页头部与出口.png', import.meta.url).pathname,
  });
  console.log('  → v27-入口页头部与出口.png');

  // ③ 换个模块看：标注产能入口带的是它自己的默认视图
  await page.goto('http://localhost:5173/e/anno-capacity', { waitUntil: 'networkidle' });
  await waitResult(page);
  await page.waitForTimeout(1200);
  await screenshot(page, 'v27-每个入口带自己的默认视图');
} finally {
  if (errors.length) console.log('PAGE ERRORS:', errors.slice(0, 5));
  await browser.close();
}
