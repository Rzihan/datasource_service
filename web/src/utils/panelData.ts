import type { ChartPoint } from '../components/ChartView';
import type { QueryResult, StringMap } from '../types';
import { toNumber } from '../utils/number';
import { columnDigits, formatScaled, isAdditiveMetric, numericText, parseScaled, sumColumn } from './format';

// 面板级的数据整形。与查询页的 ResultView 用的是同一套「长表」结构：
// 一行 = X 类目 × 一个系列 的一个点。大盘只是把它画小一点、少几个控件，
// 数据结构保持一致，图表配置项才能两边共用。
export interface PanelData {
  points: ChartPoint[];
  series: string[];
  xCount: number;
  // 主数字：指标卡形态用，也是「这一格到底多大」的答案
  total: bigint | null;
  totalText: string;
  // 不可加指标（比率 / 均值 / 去重）不能求和，给行均值
  averageText: string;
  additive: boolean;
  rowCount: number;
  truncated: boolean;
}

const MAX_SERIES = 8;

export function buildPanelData(
  result: QueryResult,
  dims: string[],
  metrics: string[],
  labelMap: StringMap,
): PanelData {
  const colNames = result.columns.map((c) => c.name);
  const xIdx = dims.length > 0 ? colNames.indexOf(dims[0]) : -1;
  const gIdx = dims.length > 1 ? colNames.indexOf(dims[1]) : -1;
  const targets = metrics
    .map((m) => ({ name: labelMap[m] || m, idx: colNames.indexOf(m) }))
    .filter((t) => t.idx >= 0);

  const all: ChartPoint[] = [];
  const sums = new Map<string, number>();
  for (const row of result.rows) {
    const x =
      xIdx >= 0 ? (row[xIdx] === null || row[xIdx] === undefined ? '(空值)' : String(row[xIdx])) : '汇总';
    const g = gIdx >= 0 ? (row[gIdx] === null || row[gIdx] === undefined ? '(空值)' : String(row[gIdx])) : '';
    for (const t of targets) {
      const raw = row[t.idx];
      const y = toNumber(raw);
      const name = g ? `${g} · ${t.name}` : t.name;
      all.push({ x, series: name, y, raw: raw === null || raw === undefined ? '' : String(raw) });
      sums.set(name, (sums.get(name) ?? 0) + (y ?? 0));
    }
  }

  let names = [...sums.keys()];
  if (names.length > MAX_SERIES) {
    // 面板比整屏小得多，8 条线已经看不清了；截断剩下的，
    // 但**要说出来截断了**——静默丢系列会让「合计」跟图上对不上。
    names = [...sums.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_SERIES)
      .map(([k]) => k);
  }
  const keep = new Set(names);
  const points = all.filter((p) => keep.has(p.series));

  const additive = metrics.length > 0 ? metrics.every((m) => isAdditiveMetric(m)) : false;
  let total: bigint | null = null;
  let totalText = '—';
  let averageText = '—';
  if (targets.length > 0) {
    const idx = targets[0].idx;
    const values = result.rows.map((r) => r[idx]);
    const digits = columnDigits(values);
    if (additive) {
      total = sumColumn(values, digits);
      totalText = formatScaled(total, digits);
    } else {
      // 比率相加是错的数（百分比之和没有意义），只给行均值
      const nums = values.map((v) => parseScaled(v, digits)).filter((v): v is bigint => v !== null);
      if (nums.length > 0 && digits >= 0) {
        const sum = nums.reduce((a, b) => a + b, 0n);
        averageText = formatScaled(sum / BigInt(nums.length), digits);
      } else {
        averageText = numericText(values[0]) ?? '—';
      }
      totalText = averageText;
    }
  }

  return {
    points,
    series: names,
    xCount: new Set(points.map((p) => p.x)).size,
    total,
    totalText,
    averageText,
    additive,
    rowCount: result.row_count,
    truncated: result.truncated,
  };
}
