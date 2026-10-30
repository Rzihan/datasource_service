// v18：空结果与报错的人话诊断 —— 0 行不是「没有结果」，是「有一个原因」
import { ensureDir, launch, queryUrl, screenshot, waitResult } from './harness.mjs';

ensureDir();
const { browser, page, errors } = await launch();

const waitDiagnosis = async (text) => {
  await page.getByText(text).first().waitFor({ timeout: 25000 });
  await page.waitForTimeout(700);
};

try {
  // ① 空结果：两条条件里「城市 = 火星基地」是不可能值，
  //    旧界面只有一句「暂无数据」，现在逐条列出并给「去掉」按钮
  const impossible = {
    logic: 'and',
    children: [
      { field: 'city', op: '=', value: '火星基地' },
      { field: 'difficulty', op: '=', value: '易' },
    ],
  };
  await page.goto(
    queryUrl({
      ds: 'robot_collection',
      dims: 'date',
      metrics: 'episodes',
      filter: impossible,
      limit: 1000,
    }),
    { waitUntil: 'networkidle' },
  );
  await waitDiagnosis('一键修复');
  await screenshot(page, 'v18-空结果-逐条列出并给去掉按钮');

  // ② 点「去掉」不是把提示关掉，而是立刻带着剩下的条件重查一次
  await page.locator('button').filter({ hasText: /^去掉「城市 = 火星基地」$/ }).click();
  await waitResult(page);
  await page.waitForTimeout(800);
  await screenshot(page, 'v18-点掉不可能的条件后结果回来了');

  // ③ 报错：筛选项里留着一个数据集已经没有的字段（多半是别人发的老链接 / 数据集改过字段）。
  //    注意 URL 里的 dims 会被「只保留真实存在的字段」过滤掉，所以这里用 filter 造这个错。
  await page.goto(
    queryUrl({
      ds: 'robot_collection',
      dims: 'date',
      metrics: 'episodes',
      filter: { logic: 'and', children: [{ field: 'ghost_field', op: '=', value: 'x' }] },
      limit: 1000,
    }),
    { waitUntil: 'networkidle' },
  );
  await waitDiagnosis('有一个字段这个数据集里已经没有了');
  await screenshot(page, 'v18-报错-字段已不存在也给解法');

  // ④ 原始错误折叠在下面：普通人看不见，要排查的人能拿到
  await page.getByText('原始错误（排查用）').click();
  await page.waitForTimeout(600);
  await screenshot(page, 'v18-原始错误折叠可展开');

  // ⑤ 另一类：产品规则类错误，用产品语言说，而不是把断言抛给用户
  await page.goto(
    queryUrl({
      ds: 'robot_collection',
      dims: 'date',
      metrics: '',
      cmp: 'prev_period',
      cmpf: 'date',
      limit: 1000,
    }),
    { waitUntil: 'networkidle' },
  );
  await waitDiagnosis('开了对比周期，但没选指标');
  await screenshot(page, 'v18-报错-对比周期缺指标');
} finally {
  if (errors.length) console.log('控制台异常：', errors.slice(0, 5));
  await browser.close();
}
