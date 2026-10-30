// v28：旧页面自己把人送过来 —— 迁移提示要出现在他正在看的那一页上
import { ensureDir, launch, screenshot, waitResult } from './harness.mjs';

ensureDir();
const { browser, page, errors } = await launch();

const clickText = async (text) => {
  await page.locator('button').filter({ hasText: text }).first().click();
  await page.waitForTimeout(700);
};

try {
  // ① 旧页面上出现迁移引导
  await page.goto('http://localhost:5173/legacy/qc_report', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  await screenshot(page, 'v28-旧页面上的迁移引导');

  // ② 点「以后再说」：提示从一整条降级成一行，不挡内容但也不消失
  await clickText('以后再说');
  await screenshot(page, 'v28-以后再说-提示降级不消失');

  // ③ 点「立即体验」：带上来处，新版先把对照摆出来
  await page.goto('http://localhost:5173/legacy/anno_capacity', { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await clickText('立即体验');
  await waitResult(page);
  await page.waitForTimeout(1200);
  await screenshot(page, 'v28-从旧版过来-先讲清对照关系');
} finally {
  if (errors.length) console.log('PAGE ERRORS:', errors.slice(0, 5));
  await browser.close();
}
