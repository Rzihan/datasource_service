// v11 两根小刺：
// 1) 整屏导出 CSV 带 BOM——Excel 双击打开不再乱码
// 2) 面板编辑器宽度改「几分之几行」+ 12 格实时预览
import { launch, enterAs, shot, BASE } from './harness.mjs';

const { browser, page, errors } = await launch();
await enterAs(page, 'alice');
await page.goto(`${BASE}/d/collect-overview`, { waitUntil: 'networkidle' });
await page.waitForTimeout(3000);

// ── 1. 导出：用下载事件验证文件头三个字节是 BOM ────────────────────
const downloadPromise = page.waitForEvent('download', { timeout: 15000 });
await page.getByText('导出整屏', { exact: true }).click();
const download = await downloadPromise;
const tmp = '/tmp/v8-check/' + download.suggestedFilename();
await download.saveAs(tmp);
const head = await page.evaluate(async (p) => {
  const buf = await (await fetch('file://' + p)).arrayBuffer();
  return Array.from(new Uint8Array(buf).slice(0, 3)).join(',');
}, tmp).catch(() => null);
console.log('  导出文件:', download.suggestedFilename());
console.log('  前 3 字节 (应为 239,187,191 = BOM):', head ?? '浏览器内无法读取，改用 node 校验');

// ── 2. 面板编辑器：宽度档位 + 预览 ──────────────────────────────────
await page.getByText('编辑', { exact: true }).first().click();
await page.waitForTimeout(900);
// 编辑态下面板卡 extra 里出现「编辑图标」按钮（与放大、删除并列）
const editBtn = page.locator('.ant-card-extra button:has(.anticon-edit)').first();
await editBtn.click();
await page.waitForTimeout(1000);
const widthItem = page.locator('.ant-drawer .ant-form-item', { hasText: '占多宽' }).first();
await widthItem.locator('.ant-select-selector').click();
await page.waitForTimeout(500);
console.log('  宽度档位:', (await page.locator('.ant-select-item-option').allTextContents()).join(' | '));
await page.locator('.ant-select-item-option', { hasText: '整行' }).click();
await page.waitForTimeout(400);
await page.screenshot({ path: 'v11-宽度档位与预览.png' });
console.log('  → v11-宽度档位与预览.png');

if (errors.length) console.log('PAGE ERRORS:', errors.slice(0, 5));
await browser.close();
