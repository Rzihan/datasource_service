// v30：迁移要能度量 —— 不看数据就不知道什么时候能下线旧页
import { ensureDir, launch, screenshot, waitResult } from './harness.mjs';

ensureDir();
const { browser, page, errors } = await launch();

try {
  // 先产生一些真实足迹：旧页点几次、新版点几次
  await page.goto('http://localhost:5173/legacy/collect_daily', { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  await page.goto('http://localhost:5173/legacy/collect_daily', { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  await page.goto('http://localhost:5173/e/collect-daily', { waitUntil: 'networkidle' });
  await waitResult(page);
  await page.goto('http://localhost:5173/e/anno-capacity', { waitUntil: 'networkidle' });
  await waitResult(page);
  await page.waitForTimeout(800);

  // ① 迁移看板：每个入口新旧各被打开了多少次
  await page.goto('http://localhost:5173/migration', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await screenshot(page, 'v30-迁移看板-新旧各被打开多少次');

  // ② 在入口页把自己调好的这一屏钉成入口默认视图
  await page.goto('http://localhost:5173/e/biz-delivery', { waitUntil: 'networkidle' });
  await waitResult(page);
  await page.waitForTimeout(1000);
  await page.locator('button').filter({ hasText: '设为该入口默认' }).click();
  await page.waitForTimeout(1800);
  await screenshot(page, 'v30-把当前这一屏钉成入口默认视图');

  // ③ 一键推进：把所有还在观察期的入口推到「默认走新版」
  await page.goto('http://localhost:5173/migration', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  await page.locator('button').filter({ hasText: '把并存的推进到默认走新版' }).click();
  await page.waitForTimeout(2500);
  await screenshot(page, 'v30-一键推进-只推进不下线');
} finally {
  if (errors.length) console.log('PAGE ERRORS:', errors.slice(0, 5));
  await browser.close();
}
