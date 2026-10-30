// v14：下钻 —— 看到一根柱子高，点一下就能只看它
import { ensureDir, launch, queryUrl, screenshot, waitResult } from './harness.mjs';

ensureDir();
const { browser, page, errors } = await launch();

// 点图上的柱子：G2 画在 canvas 上，只能按坐标点。
// 从图表容器右上往左下扫，坐标点在柱子高度范围内即可命中。
async function clickBar() {
  const box = await page.locator('.ant-tabs-tabpane-active canvas').first().boundingBox();
  if (!box) return false;
  for (const fx of [0.08, 0.14, 0.2, 0.26, 0.32]) {
    // 柱状图从底部起画，取容器 70% 高度处，通常落在柱子中段
    await page.mouse.click(box.x + box.width * fx, box.y + box.height * 0.7);
    await page.waitForTimeout(900);
    if (await page.locator('text=下钻路径').count()) return true;
  }
  return false;
}

try {
  await page.goto(
    queryUrl({ ds: 'robot_collection', dims: 'scene', metrics: 'episodes', limit: 1000 }),
    { waitUntil: 'networkidle' },
  );
  await waitResult(page);
  await page.getByRole('tab', { name: /柱状图/ }).click();
  await page.waitForTimeout(1500);
  await screenshot(page, 'v14-下钻前-场景产出');

  const ok = await clickBar();
  console.log('图表点击命中:', ok);
  await screenshot(page, 'v14-点柱子后-面包屑与单场景结果');

  // 再从表格里点维度值下钻一层：场景 → 城市
  await page.getByRole('tab', { name: /表格/ }).click();
  await page.waitForTimeout(600);
  await page.goto(
    queryUrl({ ds: 'robot_collection', dims: 'scene,city', metrics: 'episodes', limit: 1000 }),
    { waitUntil: 'networkidle' },
  );
  await waitResult(page);
  // 维度值外面套了一层 role=button，点 td 的空隙不会触发，要点到里面那个 span
  await page.getByRole('button', { name: '倒水入杯', exact: true }).first().click();
  await page.waitForTimeout(2000);
  await waitResult(page);
  await screenshot(page, 'v14-表格点值下钻');
} finally {
  if (errors.length) console.log('控制台异常：', errors.slice(0, 5));
  await browser.close();
}
