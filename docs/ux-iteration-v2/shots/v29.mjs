// v29：迁移要能推进，也要能退回来 —— 并存 / 默认走新版 / 旧页下线
import { ensureDir, launch, screenshot } from './harness.mjs';

ensureDir();
const { browser, page, errors } = await launch();

const openModule = async (name) => {
  await page.locator('.ant-menu-submenu-title').filter({ hasText: name }).click();
  await page.waitForTimeout(500);
};

try {
  // ① 同一份菜单，三种迁移状态长成三种样子
  await page.goto('http://localhost:5173/query', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await openModule('数据采集'); // 并存
  await openModule('数据标注'); // 默认走新版
  await openModule('质量检验'); // 旧页已下线
  await page.waitForTimeout(600);
  await screenshot(page, 'v29-菜单的三种迁移状态');

  // ② 配置页里能写入口：挂哪个旧页面、什么状态、默认视图是什么
  await page.goto('http://localhost:5173/datasets', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await page.locator('.ant-table-tbody button').filter({ hasText: '编辑' }).first().click();
  await page.waitForSelector('.ant-drawer-content');
  await page.waitForTimeout(600);
  await page.locator('.ant-collapse-header').filter({ hasText: '菜单入口' }).click();
  await page.waitForTimeout(700);
  await page.locator('.ant-drawer-content').screenshot({
    path: new URL('./v29-配置页里写入口与迁移状态.png', import.meta.url).pathname,
  });
  console.log('  → v29-配置页里写入口与迁移状态.png');

  // ③ 旧页下线后，从老链接进来的人知道该去哪儿
  await page.goto('http://localhost:5173/legacy/qc_report', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  await screenshot(page, 'v29-旧页已下线-老链接进来也知道去哪');

  // ④ 已经在旧页上选了「以后再说」的人，菜单尊重他的选择
  await page.goto('http://localhost:5173/legacy/anno_capacity', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  await page.locator('button').filter({ hasText: '以后再说' }).first().click();
  await page.waitForTimeout(600);
  await page.locator('.ant-menu-submenu-title').filter({ hasText: '数据标注' }).click();
  await page.waitForTimeout(500);
  await page.locator('.ant-menu-item').filter({ hasText: '标注产能看板' }).first().click();
  await page.waitForTimeout(900);
  await screenshot(page, 'v29-说了以后再说-菜单就还是进旧页');
} finally {
  if (errors.length) console.log('PAGE ERRORS:', errors.slice(0, 5));
  await browser.close();
}
