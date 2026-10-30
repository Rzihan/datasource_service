// v17：命名收藏 + 收藏夹 —— 好用的查询不该只能靠一条 URL 传来传去
import { ensureDir, launch, queryUrl, screenshot, shotCard, waitResult } from './harness.mjs';

ensureDir();
const { browser, page, errors } = await launch();

// 顶栏按钮用 CSS 定位：antd 的图标会给按钮加上 aria-label，
// getByRole 的可见名会变成「star 收藏」，精确匹配反而找不到。
const openSaveModal = async () => {
  await page.locator('.ant-card-extra button').filter({ hasText: /^收藏$/ }).click();
  await page.waitForSelector('.ant-modal-content');
  await page.waitForTimeout(400);
};
// antd 会在两字按钮中间插一个空格（「收 藏」），按文本找按钮一律走 CSS
const submitSave = async () => {
  await page.locator('.ant-modal-footer .ant-btn-primary').click();
  await page.waitForTimeout(900);
};
const saveAs = async (name) => {
  await openSaveModal();
  if (name) {
    await page.locator('.ant-modal-content input').first().fill(name);
  }
  await submitSave();
};

try {
  // ① 一张天天要看的图：默认名已经把「数据集 · 维度 · 指标」拼好了
  await page.goto(
    queryUrl({ ds: 'robot_collection', dims: 'date', metrics: 'episodes', limit: 1000 }),
    { waitUntil: 'networkidle' },
  );
  await waitResult(page);
  await openSaveModal();
  await screenshot(page, 'v17-收藏弹窗-默认名已预填');
  await submitSave();
  await page.waitForTimeout(300);
  await shotCard(page, 'v17-已收藏-按钮变实心星');

  // ② 带环比的：收藏要连「对比周期」一起存，否则打开就少了半张图
  await page.goto(
    queryUrl({
      ds: 'robot_collection',
      dims: 'date',
      metrics: 'episodes',
      cmp: 'prev_period',
      cmpf: 'date',
      limit: 1000,
    }),
    { waitUntil: 'networkidle' },
  );
  await waitResult(page);
  await saveAs('采集量周环比（每周一晨会）');

  // ③ 换一个数据集：证明收藏夹能跨数据集攒
  await page.goto(
    queryUrl({ ds: 'robot_pipeline', dims: 'scene', metrics: 'output_units', limit: 1000 }),
    { waitUntil: 'networkidle' },
  );
  await waitResult(page);
  await saveAs('各场景产出排名');

  // 收藏夹：三条、跨数据集、带环比标记、当前那条高亮
  await page.locator('.ant-card-extra button').filter({ hasText: /^收藏夹/ }).click();
  await page.waitForSelector('.ant-drawer-content');
  await page.waitForTimeout(600);
  await shotCard(page, 'v17-收藏夹-三条跨数据集', '.ant-drawer-content');

  // 改名弹窗：名字说清「看什么」，备注说清「什么时候看」
  await page.locator('.ant-drawer .anticon-edit').first().click();
  await page.waitForSelector('.ant-modal-content');
  await page.waitForTimeout(400);
  await page.locator('.ant-modal-content input').first().fill('采集量周环比');
  await page.locator('.ant-modal-content textarea').first().fill('每周一晨会第一页：昨天比前一周同一天涨了多少');
  await page.waitForTimeout(300);
  await screenshot(page, 'v17-改名与备注');
  await page.locator('.ant-modal-footer .ant-btn-primary').click();
  await page.waitForTimeout(800);

  // ④ 从收藏夹一键回到另一条：数据集、维度、指标、上限全部还原
  await page.locator('.ant-drawer').getByRole('button', { name: '打开' }).last().click();
  await page.waitForSelector('.ant-drawer-content', { state: 'hidden' });
  await waitResult(page);
  await page.waitForTimeout(900);
  await screenshot(page, 'v17-一键回到收藏的视图');
} finally {
  if (errors.length) console.log('控制台异常：', errors.slice(0, 5));
  await browser.close();
}
