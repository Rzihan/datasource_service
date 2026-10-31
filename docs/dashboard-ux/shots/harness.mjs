// 仪表盘迭代截图公共件：登录 + 起浏览器 + 落盘。
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire('/Users/Zhuanz/.workbuddy/binaries/node/workspace/');
const { chromium } = require('playwright');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const BASE = 'http://localhost:8080';

export async function launch() {
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
  return { browser, context, page, errors };
}

// dev 模式：登录页选预置身份进入
export async function enterAs(page, user) {
  await page.goto(`${BASE}/datasets`, { waitUntil: 'networkidle' });
  await page.waitForSelector('text=选择一个身份进入', { timeout: 15000 });
  await page.locator('.ant-card-small').filter({ hasText: user }).first().locator('button').click();
  await page.waitForSelector('.ant-layout-header', { timeout: 15000 });
  await page.waitForTimeout(1000);
}

export async function shot(page, name, opts = {}) {
  const file = path.join(__dirname, `${name}.png`);
  await page.screenshot({ path: file, ...opts });
  console.log(`  → ${file}`);
}
