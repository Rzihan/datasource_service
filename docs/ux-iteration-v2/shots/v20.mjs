// v20：预置分析 —— 数据集作者把「这张表该怎么用」钉在看板上
import { ensureDir, launch, queryUrl, screenshot, shotCard, waitResult } from './harness.mjs';

ensureDir();
const { browser, page, errors } = await launch();

const openPreset = async (title) => {
  await page.getByText(title, { exact: true }).click();
  await waitResult(page);
  await page.waitForTimeout(1200);
};

try {
  // ① 只选了数据集、还没查：预置分析就在手边，不用先想「该按什么维度看」
  await page.goto(queryUrl({ ds: 'robot_collection', limit: 1000 }), { waitUntil: 'networkidle' });
  await page.getByText(/^作者预置的分析（\d+）$/).waitFor({ timeout: 20000 });
  await page.waitForTimeout(1500);
  await shotCard(page, 'v20-预置分析入口与空态引导');
  await screenshot(page, 'v20-空态提示-或直接挑一个预置');

  // ② 点一下就是作者当时那张图：场景 × 产出/有效率/质量分
  await openPreset('各任务场景产出对比');
  await screenshot(page, 'v20-一键打开-场景产出对比');

  // ③ 预置里也能带对比周期：开箱就是「比上周涨了多少」
  await openPreset('采集量周环比');
  await screenshot(page, 'v20-预置带环比-开箱即对比');

  // ④ 换数据集，点带筛选条件的预置：条件区与结果一起落位
  await page.goto(queryUrl({ ds: 'robot_qc', limit: 1000 }), { waitUntil: 'networkidle' });
  await page.getByText(/^作者预置的分析（\d+）$/).waitFor({ timeout: 20000 });
  await page.waitForTimeout(1200);
  await openPreset('标注环节缺陷 TOP');
  await shotCard(page, 'v20-预置带筛选条件-条件区同步落位', '.ant-card');
  await screenshot(page, 'v20-缺陷TOP-只在标注环节内');
} finally {
  if (errors.length) console.log('控制台异常：', errors.slice(0, 5));
  await browser.close();
}
