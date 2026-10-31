// v7 大盘明细表：列排序 + 数值右对齐 + 千分位（放大弹层同步受益）
import { launch, enterAs, shot, BASE } from './harness.mjs';

const { browser, page, errors } = await launch();
await enterAs(page, 'alice');
await page.goto(`${BASE}/d/collect-overview`, { waitUntil: 'networkidle' });
await page.waitForTimeout(3000);

// 找到带明细表的面板卡
const tableCard = page.locator('.ant-card', { has: page.locator('.ant-table') }).first();
console.log('  表格面板标题:', await tableCard.locator('.ant-card-head-title').textContent());
const headers = await tableCard.locator('.ant-table-thead th').allTextContents();
console.log('  列头:', headers.join(' | '));
await tableCard.screenshot({ path: 'v7-明细表-默认.png' }).catch(() => {});
console.log('  → v7-明细表-默认.png');

// 点第一个数值列头（通常是第二个之后），先升序
const numericTh = tableCard.locator('.ant-table-thead th').nth(headers.length - 1); // 最后一列一般是数值
await numericTh.click();
await page.waitForTimeout(900);
await tableCard.screenshot({ path: 'v7-明细表-升序.png' }).catch(() => {});
console.log('  → v7-明细表-升序.png');

// 再点一次 → 降序（最大的在最上，找 top N 不用回查询页）
await numericTh.click();
await page.waitForTimeout(900);
await tableCard.screenshot({ path: 'v7-明细表-降序.png' }).catch(() => {});
console.log('  → v7-明细表-降序.png');

// 放大弹层里的同一张表：排序与格式同样生效
const expandBtn = tableCard.locator('.ant-card-extra button.ant-btn-text').first();
await expandBtn.click();
await page.waitForSelector('.ant-modal-content', { timeout: 8000 });
await page.waitForTimeout(2000);
const modalTable = page.locator('.ant-modal .ant-table').first();
const mHeaders = await modalTable.locator('.ant-table-thead th').allTextContents();
await modalTable.locator('.ant-table-thead th').nth(mHeaders.length - 1).click();
await page.waitForTimeout(700);
await modalTable.locator('.ant-table-thead th').nth(mHeaders.length - 1).click();
await page.waitForTimeout(700);
await page.locator('.ant-modal').screenshot({ path: 'v7-放大弹层-降序.png' }).catch(() => {});
console.log('  → v7-放大弹层-降序.png');

if (errors.length) console.log('PAGE ERRORS:', errors.slice(0, 5));
await browser.close();
