import type { DatasetEntry, QueryDataset } from '../types';
import type { LegacyPage } from './legacyPages';
import { findLegacyPage, MODULES } from './legacyPages';

// 一个「菜单入口」= 一个数据集 + 它挂在哪个旧页面上 + 打开时跑什么。
//
// 注意入口不是「跳到查询页」的快捷方式：它带着固定的数据集和固定的默认视图，
// 打开就该是用户熟悉的那张图。只挂数据集、进去是空构建器，等于把「找」换个地方。
export interface EntryItem {
  key: string;
  datasetKey: string;
  datasetName: string;
  // 菜单标题：作者写了就用作者的，没写用数据集名
  title: string;
  module: string;
  legacy?: string;
  status: 'parallel' | 'default' | 'replaced';
  note?: string;
  defaultQuery?: string;
  sort: number;
  dataset: QueryDataset;
  legacyPage?: LegacyPage;
}

export type EntryStatus = EntryItem['status'];

// 从数据集列表里抽出所有挂了入口的数据集。
// 入口存在 meta 里而不是单独一张表：它就是作者的一句声明「我该出现在哪个菜单下」，
// 跟说明书是同一类东西，不参与 SQL 生成，也没必要为它再建一套存储。
export function collectEntries(datasets: QueryDataset[]): EntryItem[] {
  const out: EntryItem[] = [];
  for (const ds of datasets) {
    const e = ds.meta?.entry;
    if (!e || !e.key) continue;
    const legacyPage = findLegacyPage(e.legacy);
    out.push({
      key: e.key,
      datasetKey: ds.dataset_key,
      datasetName: ds.dataset_name,
      title: e.title || ds.dataset_name,
      module: e.module || legacyPage?.module || '未分组',
      legacy: e.legacy,
      status: e.status || 'parallel',
      note: e.note,
      defaultQuery: e.default_query,
      sort: e.sort ?? 100,
      dataset: ds,
      legacyPage,
    });
  }
  // 同一菜单下的顺序：作者指定的 sort 优先，其次按入口 key 稳定排序。
  // 稳定排序是必须的——返回顺序一抖，菜单就会跟着跳。
  return out.sort((a, b) => (a.sort - b.sort) || a.key.localeCompare(b.key));
}

export function findEntry(entries: EntryItem[], key: string | undefined): EntryItem | undefined {
  if (!key) return undefined;
  return entries.find((e) => e.key === key);
}

// 一个菜单分组 = 一个模块。模块下依次是：旧页面项、它的可视化查询版项。
export interface MenuGroup {
  module: string;
  pages: Array<{
    page: LegacyPage;
    entries: EntryItem[];
    // 这个「页面」其实是一个没有对应旧页的入口：菜单上没有旧项可比，
    // 只有它自己，后缀也就无从谈起。
    orphan?: boolean;
  }>;
}

// 菜单按「模块 → 页面」两级搭，入口挂在页面下面。
// 没有对应旧页的入口（作者没写 legacy）单独挂在模块下。
export function buildMenuGroups(entries: EntryItem[]): MenuGroup[] {
  const groups: MenuGroup[] = [];
  const groupOf = (module: string) => {
    let g = groups.find((x) => x.module === module);
    if (!g) {
      g = { module, pages: [] };
      groups.push(g);
    }
    return g;
  };
  for (const m of MODULES) groupOf(m);

  for (const e of entries) {
    const g = groupOf(e.module);
    if (e.legacyPage) {
      let slot = g.pages.find((p) => p.page.key === e.legacyPage?.key);
      if (!slot) {
        slot = { page: e.legacyPage, entries: [] };
        g.pages.push(slot);
      }
      slot.entries.push(e);
    } else {
      // 不替代任何旧页的入口：挂在模块下，自己就是一个菜单项
      g.pages.push({
        page: {
          key: `__entry_${e.key}`,
          title: e.title,
          module: e.module,
          desc: e.note || '',
          columns: [],
          rows: [],
        },
        entries: [e],
        orphan: true,
      });
    }
  }
  // 模块内页面顺序沿用清单顺序；清单里没有的（孤儿入口）排在后面
  for (const g of groups) {
    g.pages.sort((a, b) => {
      const ia = MODULES.length + indexInList(a.page.key);
      const ib = MODULES.length + indexInList(b.page.key);
      return ia - ib;
    });
  }
  return groups.filter((g) => g.pages.length > 0);
}

function indexInList(key: string): number {
  const i = ['collect_daily', 'anno_capacity', 'qc_report', 'biz_delivery', 'ops_pipeline'].indexOf(key);
  return i < 0 ? 999 : i;
}

// 入口在菜单上显示的名字。
//
// 后缀是「状态驱动的临时标记」，不是名字的一部分：
//   - 并存期要区分新旧，所以带「（可视化查询版）」；
//   - 旧页下线后就只剩它一个了，再挂着「版」字就是噪音。
// 收敛后自动变回原页面名，菜单不会永久留下迁移的痕迹。
export function entryMenuLabel(e: EntryItem): string {
  const base = e.legacyPage ? e.legacyPage.title : e.title;
  return e.status === 'replaced' ? base : `${base}（可视化查询版）`;
}

export function statusText(status: EntryStatus): string {
  switch (status) {
    case 'default':
      return '默认走新版';
    case 'replaced':
      return '旧页已下线';
    default:
      return '并存';
  }
}

// 空 entry 模板，配置页新增入口时用
export function emptyEntry(): DatasetEntry {
  return { key: '', title: '', module: '', legacy: '', status: 'parallel', note: '', default_query: '', sort: 100 };
}
