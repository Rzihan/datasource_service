// 迁移引导的选择，按旧页面记。
//
// 存本地而不是后端：这是「我个人现在用不用新版」的偏好，不是系统配置。
// 但它是按 page 记的，不是全局的——一个人可能在「采集日报」上已经切过去了，
// 而「质检日报」还想再看看，用一刀切的选择会逼他在两个页面之间来回改。
const KEY_PREFIX = 'ds_migrate_';

// undecided 还没表态；later 看了但还想先用旧版（提示降级成一行，不再挡着）；
// never 明确不想再看到（彻底消失，但仍然能从菜单进新版）。
export type MigrateChoice = 'undecided' | 'later' | 'never';

export function readMigrateChoice(pageKey: string): MigrateChoice {
  const v = localStorage.getItem(KEY_PREFIX + pageKey);
  return v === 'later' || v === 'never' ? v : 'undecided';
}

export function writeMigrateChoice(pageKey: string, choice: MigrateChoice): void {
  if (choice === 'undecided') {
    localStorage.removeItem(KEY_PREFIX + pageKey);
    return;
  }
  localStorage.setItem(KEY_PREFIX + pageKey, choice);
}
