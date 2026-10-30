import type { CompareRequest, FilterNode, OrderBy } from '../types';

// 收藏：和历史的区别是「有名字、不会被挤掉」。
// 历史是「我刚才查过什么」，滚动的、20 条就丢；
// 收藏是「这张图我每周都要看一次」，得起个名字才能找回来。
//
// 存在浏览器本地：这个服务不接鉴权，为收藏去建表建接口不划算。
// 代价是换浏览器就没了——和历史一个量级的选择，保持一致。
export interface FavoriteEntry {
  id: string;
  name: string;
  note?: string;
  ts: number;
  // 置顶：常用那几条不该被新收藏挤到下面去
  pinned?: boolean;
  // 默认视图：打开这个数据集时自动跑它。
  // 老手的问题不是「找不到」，是「每天都得点一次」——
  // 作者的建议挂在数据集上，我的分析也应该能挂上去，而且优先级更高。
  isDefault?: boolean;
  datasetKey: string;
  dims: string[];
  metrics: string[];
  filterTree: FilterNode;
  orderBy: OrderBy | null;
  limit: number;
  compare: CompareRequest | null;
}

export type FavoriteInput = Omit<FavoriteEntry, 'id' | 'ts'>;

const KEY = 'ds_query_favorites';
// 收藏不该被悄悄丢掉，给一个比历史大得多的上限
const MAX = 200;

export function loadFavorites(): FavoriteEntry[] {
  try {
    const arr = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(arr) ? (arr as FavoriteEntry[]) : [];
  } catch {
    return [];
  }
}

function write(list: FavoriteEntry[]): FavoriteEntry[] {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // 隐私模式 / 配额满：存不下不影响查数，但这次修改只在内存里有效
  }
  return list;
}

// 口径指纹：判断「当前这一屏是不是已经收藏过」。
// 名字和备注不算口径——改个名不该让按钮失去「已收藏」状态。
export function favoriteSignature(e: Omit<FavoriteInput, 'name' | 'note'>): string {
  return JSON.stringify([e.datasetKey, e.dims, e.metrics, e.filterTree, e.orderBy, e.limit, e.compare]);
}

export function findFavorite(
  list: FavoriteEntry[],
  e: Omit<FavoriteInput, 'name' | 'note'>,
): FavoriteEntry | undefined {
  const sig = favoriteSignature(e);
  return list.find((f) => favoriteSignature(f) === sig);
}

// 同名覆盖：用户给一个查询改名字再存，多半是想替换，不是想多一条
export function saveFavorite(entry: FavoriteInput): FavoriteEntry[] {
  const list = loadFavorites();
  const sig = favoriteSignature(entry);
  const idx = list.findIndex((f) => favoriteSignature(f) === sig);
  // 存进来即为默认时，同一数据集的旧默认要被顶掉：
  // 两条默认意味着「打开数据集该看到什么」没有答案。
  const clearOthers = (next: FavoriteEntry[]) =>
    entry.isDefault
      ? next.map((f) => (f.datasetKey === entry.datasetKey && !f.isDefault ? f : f.datasetKey === entry.datasetKey && f.isDefault && favoriteSignature(f) !== sig ? { ...f, isDefault: false } : f))
      : next;
  if (idx >= 0) {
    const next = [...list];
    next[idx] = { ...list[idx], ...entry, name: entry.name, ts: Date.now() };
    return write(clearOthers(next));
  }
  const created: FavoriteEntry = { ...entry, id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, ts: Date.now() };
  return write(clearOthers([created, ...list]).slice(0, MAX));
}

// 设为默认视图：同一个数据集只保留一个默认，新的会顶掉旧的。
// 不允许多条默认——那样「打开数据集该看到什么」就没有答案了。
export function setDefaultFavorite(id: string, on: boolean): FavoriteEntry[] {
  const list = loadFavorites();
  const target = list.find((f) => f.id === id);
  if (!target) return list;
  return write(
    list.map((f) => {
      if (f.id === id) return { ...f, isDefault: on };
      // 把同一数据集里其它条目的默认标记清掉
      return f.datasetKey === target.datasetKey && f.isDefault ? { ...f, isDefault: false } : f;
    }),
  );
}

export function togglePinFavorite(id: string): FavoriteEntry[] {
  return write(loadFavorites().map((f) => (f.id === id ? { ...f, pinned: !f.pinned } : f)));
}

// 列表排序：默认视图第一，其次置顶，其余按收藏时间。
// 默认视图排最前不是装饰——它表达了「打开这个数据集时你会看到的就是这条」。
export function sortFavorites(list: FavoriteEntry[]): FavoriteEntry[] {
  return [...list].sort((a, b) => {
    if (!!a.isDefault !== !!b.isDefault) return a.isDefault ? -1 : 1;
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    return b.ts - a.ts;
  });
}

export function renameFavorite(id: string, patch: { name?: string; note?: string }): FavoriteEntry[] {
  return write(loadFavorites().map((f) => (f.id === id ? { ...f, ...patch } : f)));
}

export function removeFavorite(id: string): FavoriteEntry[] {
  return write(loadFavorites().filter((f) => f.id !== id));
}

export function clearFavorites(): FavoriteEntry[] {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // 同上
  }
  return [];
}
