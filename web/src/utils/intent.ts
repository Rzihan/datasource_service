import type { CompareRequest, FilterNode, OrderBy, QueryDataset } from '../types';
import { emptyRoot } from './filterTree';

// 一次查询的完整输入。抽成对象是为了两件事：
//   1. 从 URL 恢复时要拿「刚解析出来的值」直接查，不能等 setState 生效；
//   2. 查询历史回填时要能一次性替换掉全部条件。
export interface QueryIntent {
  key: string;
  dims: string[];
  metrics: string[];
  filterTree: FilterNode;
  orderBy: OrderBy | null;
  limit: number;
  compare: CompareRequest | null;
}

export const MAX_LIMIT = 10000;

// 把一段查询串解析成一次查询意图。
//
// 查询页的 URL、作者预置的分析、入口默认视图、大盘里的面板，四种东西
// 共用这一份解析：它们存的都是同一段查询串。只要链接能还原，其余三种
// 就一定能还原——不需要维护四套规则，也不会出现「链接能开、面板开不了」。
export function parseIntent(ds: QueryDataset, sp: URLSearchParams): QueryIntent {
  // 查询串可能来自别的环境 / 数据集改过字段，只保留当前数据集真实存在的字段
  const parseList = (name: string, allowed: (f: string) => boolean) =>
    (sp.get(name) ?? '').split(',').filter((v) => v && allowed(v));

  const dims = parseList('dims', (f) => f in ds.dim_map || f in ds.multi_dim_map);
  const metrics = parseList('metrics', (f) => f in ds.mtx_map);

  let filter: FilterNode = emptyRoot();
  const rawFilter = sp.get('filter');
  if (rawFilter) {
    try {
      filter = JSON.parse(rawFilter) as FilterNode;
    } catch {
      filter = emptyRoot();
    }
  }
  const orderField = sp.get('order') ?? '';
  const order: OrderBy | null = orderField ? { field: orderField, desc: sp.get('dir') !== 'asc' } : null;
  const parsedLimit = Number(sp.get('limit') ?? 1000) || 1000;
  const safeLimit = Math.min(Math.max(parsedLimit, 1), MAX_LIMIT);
  const cmpMode = sp.get('cmp');
  const cmpField = sp.get('cmpf') ?? '';
  const cmp: CompareRequest | null =
    (cmpMode === 'prev_period' || cmpMode === 'prev_year') && cmpField in ds.dim_map
      ? { mode: cmpMode, field: cmpField }
      : null;
  return { key: ds.dataset_key, dims, metrics, filterTree: filter, orderBy: order, limit: safeLimit, compare: cmp };
}

// 面板为空时也要能出数：给数据集的第一个指标 + 第一个维度。
// 大盘刚建出来时作者还没配过查询，此时一个空白面板比一句「请配置」有用——
// 先让他看到数据长什么样，再决定怎么改。
export function fallbackQuery(ds: QueryDataset): URLSearchParams {
  const sp = new URLSearchParams();
  const dims = Object.keys(ds.dim_map);
  const metrics = Object.keys(ds.mtx_map);
  if (dims.length > 0) sp.set('dims', dims[0]);
  if (metrics.length > 0) sp.set('metrics', metrics[0]);
  sp.set('limit', '200');
  return sp;
}

// 面板实际要用的查询串：自己没配就退回兜底查询。
export function panelQuery(ds: QueryDataset, query?: string): URLSearchParams {
  const sp = new URLSearchParams(query ?? '');
  if (sp.get('dims') || sp.get('metrics')) return sp;
  return fallbackQuery(ds);
}
