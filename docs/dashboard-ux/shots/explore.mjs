// 自由体验：把平台各主要页面走一遍截图，从用户视角找不顺手的点
import { launch, enterAs, shot, BASE } from './harness.mjs';

const { browser, page, errors } = await launch();
await enterAs(page, 'alice');

const stops = [
  ['explore-数据集', '/datasets'],
  ['explore-数据标注', '/labels'],
  ['explore-可视化查询', '/query'],
  ['explore-仪表盘列表', '/dashboards'],
];

for (const [name, path] of stops) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2200);
  await shot(page, name);
  console.log('  →', name);
}

// legacy 看板：先去大盘列表页找链接，或直接试常见 key
for (const key of ['collect', 'quality', 'anno']) {
  await page.goto(`${BASE}/legacy/${key}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1800);
  if (!(await page.locator('text=不存在或已下线').count())) {
    await shot(page, `explore-legacy-${key}`);
    console.log('  → explore-legacy-' + key);
  } else {
    console.log('  × /legacy/' + key, '不存在');
  }
}

if (errors.length) console.log('PAGE ERRORS:', errors.slice(0, 8));
await browser.close();
