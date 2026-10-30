// 截图脚本的公共部分：每版只写自己的场景，重复的东西（起浏览器、等结果、
// 隐藏悬浮提示、落盘）集中在这里。
//
// 用法：node vXX.mjs
// 产物：与本文件同级的 *.png
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 用本机真实 Chrome：企业微信/公司网关 + download-on-demand 的 chromium 组合有时会卡住
export const BASE = 'http://localhost:5173';

export async function launch() {
  const browser = await chromium.launch({ channel: 'chrome' });
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 2,
    locale: 'zh-CN',
  });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  // 图表上方的「推荐用…」tooltip 和下拉面板会挡住要截的东西
  await page.addInitScript(() => {
    const style = document.createElement('style');
    style.innerHTML = '.ant-tooltip,.ant-popover,.ant-select-dropdown-hidden{display:none!important}';
    document.addEventListener('DOMContentLoaded', () => document.head.appendChild(style));
  });
  return { browser, context, page, errors };
}

// 直接用查询链接进入：URL 本身就是上一轮做的「可分享的查询」，
// 比一步步点下拉稳，也不会因为控件顺序变化而失效。
export function queryUrl(params) {
  const sp = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v === undefined || v === null || v === '') return;
    sp.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  });
  return `${BASE}/query?${sp.toString()}`;
}

// 等「查完了」：概览条出现（有结果）或空态出现（没结果）。
// 不看 .ant-tabs —— 单行汇总时表格被收起，没有 tab 但仍然算查完了。
export async function waitResult(page, timeout = 30000) {
  await page.waitForFunction(
    () => !!document.querySelector('.ant-statistic') || !!document.querySelector('.ant-empty'),
    { timeout },
  );
  await page.waitForTimeout(1300); // 等 G2 动画走完，否则柱子截到一半
}

export async function screenshot(page, name, opts = {}) {
  const file = path.join(__dirname, `${name}.png`);
  await page.screenshot({ path: file, ...opts });
  console.log(`  → ${file}`);
  return file;
}

export async function shotCard(page, name, selector = '.ant-card') {
  const el = await page.$(selector);
  await el.screenshot({ path: path.join(__dirname, `${name}.png`) });
  console.log(`  → ${name}.png`);
}

export function ensureDir() {
  fs.mkdirSync(__dirname, { recursive: true });
}
