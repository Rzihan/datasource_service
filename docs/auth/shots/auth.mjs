// 登录与授权：把「未登录 → 选身份 → 顶栏显示我是谁 → 只读身份被拒」这条链路截下来。
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire('/Users/Zhuanz/.workbuddy/binaries/node/workspace/');
const { chromium } = require('playwright');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'http://localhost:8080';

const browser = await chromium.launch({ channel: 'chrome' });
const context = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
  deviceScaleFactor: 2,
  locale: 'zh-CN',
});
const page = await context.newPage();
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));

const shot = async (name, opts = {}) => {
  const file = path.join(__dirname, `${name}.png`);
  await page.screenshot({ path: file, ...opts });
  console.log(`  → ${file}`);
};

const enterAs = async (user) => {
  // 外层还有一张大 Card，必须精确到身份行（.ant-card-small）
  await page.locator('.ant-card-small').filter({ hasText: user }).first().locator('button').click();
  await page.waitForSelector('.ant-layout-header', { timeout: 15000 });
  await page.waitForTimeout(1200);
};

// 1) 未登录：直接访问任意页面都被挡在登录页
await page.goto(`${BASE}/datasets`, { waitUntil: 'networkidle' });
await page.waitForSelector('text=选择一个身份进入', { timeout: 15000 });
await page.waitForTimeout(600);
await shot('01-未登录时落在登录页');

// 2) 选 alice（editor）进入：顶栏显示身份，而不是三个自报输入框
await enterAs('alice');
await shot('02-登录后顶栏显示身份');

// 3) 退出：清掉 token 立刻回到登录页
await page.locator('.ant-layout-header button').last().click();
await page.waitForSelector('text=选择一个身份进入', { timeout: 15000 });
await page.waitForTimeout(600);
await shot('03-退出后回到登录页');

// 4) 换 bob（viewer）：能看数，但改配置会被后端拦下
await enterAs('bob');
await page.locator('button').filter({ hasText: '新建配置' }).first().click();
await page.waitForSelector('.ant-drawer', { timeout: 10000 });
await page.waitForTimeout(800);
// 必填项要填满，否则拦下它的是前端表单校验，而不是后端的角色校验
await page.locator('.ant-drawer input').first().fill('viewer-try');
await page.locator('.ant-drawer input[placeholder="例如 订单日报"]').fill('viewer 试建');
await page.locator('.monaco-editor').first().click();
await page.keyboard.type('SELECT 1 AS a');
await page.waitForTimeout(400);
// antd 会在两字按钮中间插空格（"保 存"），用正则才匹配得到
await page.locator('.ant-drawer button').filter({ hasText: /保\s*存/ }).first().click();
await page.waitForSelector('.ant-message-error, .ant-message-notice', { timeout: 15000 });
await page.waitForTimeout(800);
await shot('04-只读身份改配置被拒');

console.log(errors.length ? `console errors:\n${errors.join('\n')}` : 'no console errors');
await browser.close();
