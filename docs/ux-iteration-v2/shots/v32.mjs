import { launch, screenshot } from './harness.mjs';

// v32：没有整屏筛选的大盘只是一堆互不相干的图拼在一起。
// 联动要满足三件事：能一起收窄、能点图追问、收窄了要说清楚谁没跟着变。
const { browser, page } = await launch();

async function panelBox(keyword) {
  const cards = page.locator('.ant-card');
  for (let i = 0; i < (await cards.count()); i++) {
    if ((await cards.nth(i).innerText()).includes(keyword)) {
      return await cards.nth(i).locator('canvas').first().boundingBox();
    }
  }
  return null;
}

// 1) 顶部筛选条：候选值来自真实数据，不是手敲的
await page.goto('http://localhost:5173/d/collect-overview', { waitUntil: 'networkidle' });
await page.waitForTimeout(4500);
await screenshot(page, 'v32-整屏筛选条-候选值来自真实数据');

// 2) 选一个团队：跟随的面板出现「已筛选」角标，对比型面板标「不跟随」
const bar = page.locator('.ant-card').first();
await bar.locator('.ant-select').first().click();
await page.waitForTimeout(700);
await page.locator('.ant-select-item-option').nth(1).click();
await page.waitForTimeout(4000);
await screenshot(page, 'v32-收窄之后-跟随的变了-对比的那块没变', { fullPage: true });

// 3) 点柱状图下钻：把「这根柱子是谁」变成整屏筛选
const box = await panelBox('各团队采集条数');
await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.5);
await page.waitForTimeout(300);
await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.5);
await page.waitForTimeout(4000);
await screenshot(page, 'v32-点图形下钻-把追问变成整屏筛选', { fullPage: true });

await browser.close();
console.log('v32 shots done');
