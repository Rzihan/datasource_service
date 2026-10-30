// v23：左栏压回一屏 —— 不是每次都要改的东西，不该占着首屏
import { ensureDir, launch, queryUrl, screenshot, shotCard, waitResult } from './harness.mjs';

ensureDir();
const { browser, page, errors } = await launch();

const card = () => page.locator('.ant-card').filter({ hasText: '查询构建器' });

try {
  // ① 完整档：高级区展开，十来个控件从头排到尾
  await page.goto(
    queryUrl({ ds: 'robot_collection', dims: 'scene', metrics: 'episodes', limit: 1000 }),
    { waitUntil: 'networkidle' },
  );
  await waitResult(page);
  await page.getByText('数据行数').first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(1500);
  await shotCard(page, 'v23-完整档-高级区展开很长');

  // ② 切简洁档：时间范围 / 对比周期 / 排序 / 上限收成一行，左栏回到一屏
  await page.locator('.ant-segmented-item').filter({ hasText: '简洁' }).click();
  await page.waitForTimeout(1200);
  await shotCard(page, 'v23-简洁档-左栏回到一屏');
  await screenshot(page, 'v23-简洁档-整页');

  // ③ 收起不等于藏起来：高级区里生效的项要在收起状态下列出来
  await page.goto(
    queryUrl({
      ds: 'robot_collection',
      dims: 'date',
      metrics: 'episodes',
      order: 'episodes',
      dir: 'desc',
      limit: 3000,
      cmp: 'prev_period',
      cmpf: 'date',
    }),
    { waitUntil: 'networkidle' },
  );
  await waitResult(page);
  await page.waitForTimeout(1500);
  await shotCard(page, 'v23-收起时也显示有几项生效');

  // ④ 展开高级区：改完立刻能收回去，且手动状态被记住
  await card().getByText('展开', { exact: true }).last().click();
  await page.waitForTimeout(700);
  await shotCard(page, 'v23-展开高级区改条件');
} finally {
  if (errors.length) console.log('控制台异常：', errors.slice(0, 5));
  await browser.close();
}
