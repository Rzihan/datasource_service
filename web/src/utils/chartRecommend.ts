import type { ChartType } from '../components/ChartView';
import type { QueryResult } from '../types';
import { toNumber } from './number';

// 「智能推荐」的规则层：纯函数，不碰 React，方便单独推演和测试。
//
// 推荐结果只可能是页面上的四个 tab 之一（表格 / 柱状图 / 折线图 / 饼图）——
// 推荐的东西必须是用户一眼能找到的，推荐一个不存在的图没有任何意义。
//
// 判断依据只有四类，都能从查询结果本身推出来，不需要后端配合：
//   1. 形状：几个维度 × 几个指标（维度数决定分类轴/分组，指标数决定系列数）
//   2. X 轴是不是时间（类型、字段名、取值样式三重判断，任一中即认为时间）
//   3. 类目多不多（X 有多少个不同取值，决定标签放不放得下）
//   4. 指标之间的量级差（太大就别画图了，图上小的那个会被压平）

export type ChartKind = ChartType | 'table';

export interface ChartShape {
  dimCount: number; // 参与画图的维度数（X 轴算一个，分组算一个）
  metricCount: number; // Y 轴指标数
  xCount: number; // X 轴的不同取值个数
  hasGroup: boolean; // 是否用了第二个维度做分组
  temporal: boolean; // X 轴是否为时间
  magnitudeRatio: number; // 各指标最大绝对值之间的倍差，单指标恒为 1
}

export interface Recommendation {
  type: ChartKind;
  headline: string; // 简短描述：2 个维度 × 1 个指标
  reason: string; // 为什么推荐它
}

const TEMPORAL_TYPE = /^(Nullable\()?(Date|Date32|DateTime|DateTime64)/i;
const TEMPORAL_NAME = /(^|_)(date|dt|day|month|week|hour|time|ts|timestamp)($|_)/i;
const TEMPORAL_NAME_CN = /日期|时间|月份|年份/;
// 2026-10、2026/10/01、20261001、2026年10月 都算时间样式
const TEMPORAL_VALUE = /^(\d{4}[-/]\d{1,2}([-/]\d{1,2})?|\d{8}|\d{4}年\d{1,2}月?)$/;

// detectTemporal 判断 X 轴是不是时间。
// 三重判断是刻意为之：列名是 date 但存的是字符串、列类型是 String 但取值全是日期，
// 这两种情况在实际数据里都很常见，只看一种会漏。
export function detectTemporal(
  columnName: string,
  columnType: string | undefined,
  samples: unknown[],
): boolean {
  if (columnType && TEMPORAL_TYPE.test(columnType)) return true;
  if (TEMPORAL_NAME.test(columnName) || TEMPORAL_NAME_CN.test(columnName)) return true;

  const vals = samples
    .filter((v) => v !== null && v !== undefined && String(v).trim() !== '')
    .slice(0, 5);
  if (vals.length === 0) return false;
  return vals.every((v) => TEMPORAL_VALUE.test(String(v).trim()));
}

// magnitudeRatio 算各指标量级之间的倍差，用来判断「这张图还值不值得画」。
// 全为 0 或只有单个指标的列不参与，避免除零和「1 倍差」的假结论。
export function magnitudeRatio(rows: unknown[][], indexes: number[]): number {
  const maxes: number[] = [];
  for (const idx of indexes) {
    let m = 0;
    for (const row of rows) {
      const n = toNumber(row[idx]);
      if (n !== null && Math.abs(n) > m) m = Math.abs(n);
    }
    if (m > 0) maxes.push(m);
  }
  if (maxes.length < 2) return 1;
  return Math.max(...maxes) / Math.min(...maxes);
}

// buildShape 从查询结果 + 当前图表字段推导出形状特征。
export function buildShape(args: {
  result: QueryResult;
  xField: string;
  groupField: string;
  yFields: string[];
}): ChartShape {
  const { result, xField, groupField, yFields } = args;
  const colNames = result.columns.map((c) => c.name);
  const xIdx = xField ? colNames.indexOf(xField) : -1;
  const gIdx = groupField ? colNames.indexOf(groupField) : -1;
  const yIdx = yFields.map((f) => colNames.indexOf(f)).filter((i) => i >= 0);

  const xs = new Set<string>();
  if (xIdx >= 0) {
    for (const row of result.rows) {
      const v = row[xIdx];
      xs.add(v === null || v === undefined ? '(空值)' : String(v));
    }
  }

  const col = xIdx >= 0 ? result.columns[xIdx] : undefined;
  const temporal =
    xIdx >= 0 && !!col && detectTemporal(col.name, col.type, result.rows.slice(0, 10).map((r) => r[xIdx]));

  return {
    dimCount: (xIdx >= 0 ? 1 : 0) + (gIdx >= 0 ? 1 : 0),
    metricCount: yIdx.length,
    xCount: xs.size,
    hasGroup: gIdx >= 0,
    temporal,
    magnitudeRatio: magnitudeRatio(result.rows, yIdx),
  };
}

// recommend 按优先级给出推荐。顺序即优先级：
// 先排除「不值得画」的情况，再看趋势，再看占比，剩下的一律柱状。
// 每条分支都给得出「为什么」，因为界面要把理由直接展示给用户——
// 说不出理由的推荐，用户凭什么信。
export function recommend(shape: ChartShape): Recommendation {
  const { dimCount, metricCount, xCount, hasGroup, temporal, magnitudeRatio: ratio } = shape;
  const headline = `${dimCount} 个维度 × ${metricCount} 个指标`;

  // 0. 没有指标就什么都画不出来，只能看数
  if (metricCount === 0) {
    return { type: 'table', headline, reason: '还没选指标，画图没有意义' };
  }

  // 1. 指标之间差几个数量级：图上小的那条会被压成贴着 0 的平线，看表更准
  if (metricCount >= 2 && ratio >= 50) {
    return {
      type: 'table',
      headline,
      reason: `${metricCount} 个指标量级相差约 ${Math.round(ratio)} 倍，图上小的会被压平，看表格更准`,
    };
  }

  // 2. X 是时间：趋势优先，类目再多也是折线
  if (temporal && xCount >= 3) {
    return { type: 'line', headline, reason: '横轴是时间字段，折线看趋势最直接' };
  }

  // 3. 单指标、不分组、类目不多：这时「占比」才是主要问题
  if (metricCount === 1 && !hasGroup && xCount >= 3 && xCount <= 8) {
    return { type: 'pie', headline, reason: `${xCount} 个类目看占比，饼图最直观` };
  }

  // 4. 没有维度：所有指标汇总成一个值，折线画出来是空的，饼图也没有占比可言
  if (dimCount === 0) {
    return { type: 'column', headline, reason: '未选维度，只有一个汇总值，柱状图最直接' };
  }

  // 5. 分组或多指标：本质是「多组柱子的对比」
  if (hasGroup || metricCount >= 2) {
    return { type: 'column', headline, reason: '分类对比用柱状更清晰' };
  }

  // 6. 兜底：单指标单维度的通用形状
  return { type: 'column', headline, reason: '单指标单维度，柱状图通用性最好' };
}
