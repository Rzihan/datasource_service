import type { FilterNode, OrderBy } from '../types';

// 查询历史存在浏览器本地：这个服务不接鉴权、也没有「我的查询」这种实体，
// 为了历史去建表建接口不划算。代价是换浏览器就没了，够用。
export interface HistoryEntry {
  id: string;
  ts: number;
  datasetKey: string;
  dims: string[];
  metrics: string[];
  filterTree: FilterNode;
  orderBy: OrderBy | null;
  limit: number;
  rows: number;
  elapsedMs: number;
}

const KEY = 'ds_query_history';
const MAX = 20;

export function loadHistory(): HistoryEntry[] {
  try {
    const arr = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(arr) ? (arr as HistoryEntry[]) : [];
  } catch {
    return [];
  }
}

// 同一个查询只留最近一条：反复点「查数」不该把历史刷成 20 条一样的。
// 判重看「数据集 + 维度 + 指标 + 条件 + 排序」，行数和耗时不算口径。
function signature(e: Pick<HistoryEntry, 'datasetKey' | 'dims' | 'metrics' | 'filterTree' | 'orderBy'>): string {
  return JSON.stringify([e.datasetKey, e.dims, e.metrics, e.filterTree, e.orderBy]);
}

export function pushHistory(entry: Omit<HistoryEntry, 'id' | 'ts'>): HistoryEntry[] {
  const next: HistoryEntry = {
    ...entry,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ts: Date.now(),
  };
  const sig = signature(entry);
  const rest = loadHistory().filter((e) => signature(e) !== sig);
  const list = [next, ...rest].slice(0, MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // 隐私模式 / 配额满：历史存不下不影响查数，静默跳过
  }
  return list;
}

export function clearHistory(): HistoryEntry[] {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // 同上
  }
  return [];
}

// 历史列表的时间感：今天显示时分，更早显示日期。
// 不引 dayjs 的相对时间插件——只有三种情况，不值得多一个依赖。
export function historyTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return `今天 ${hm}`;
  const yesterday = new Date(now.getTime() - 86400000);
  if (d.toDateString() === yesterday.toDateString()) return `昨天 ${hm}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
}
