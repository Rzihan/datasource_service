import { Area, Bar, Column, DualAxes, Line, Pie } from '@ant-design/charts';
import type { FC } from 'react';

// G2 v5 的配置项非常宽（且版本间变动大），逐项对齐类型不划算。
// 这里把组件放宽成「任意 props」，配置对象用 Record 承载，既过得了 tsc，
// 也不会因为某个配置名拼错就整块编译失败——代价是配置项只能靠运行时验证。
type LooseChart = FC<Record<string, unknown>>;
const LLine = Line as unknown as LooseChart;
const LColumn = Column as unknown as LooseChart;
const LBar = Bar as unknown as LooseChart;
const LArea = Area as unknown as LooseChart;
const LPie = Pie as unknown as LooseChart;
const LDualAxes = DualAxes as unknown as LooseChart;

// 图表的数据点是「长表」：一行 = X 类目 × 一个系列 的一个点。
// 用长表而不是宽表，是为了让「多指标」和「按第二维度分组」走同一条构建路径。
export interface ChartPoint {
  x: string; // X 轴类目，NULL 已转成「(空值)」
  series: string; // 系列名：指标名，或「分组值 · 指标名」
  y: number | null; // 画图用。NULL 保持 null，绝不当成 0
  raw: string; // 后端返回的原始值，tooltip 用它与表格对齐
}

export type ChartType = 'line' | 'column' | 'bar' | 'area' | 'pie' | 'dual';

interface Props {
  data: ChartPoint[];
  type: ChartType;
  series: string[];
  stacked?: boolean;
  height?: number;
  xCount?: number; // X 类目数，过多时加 slider
  xLabel?: string;
  yLabel?: string;
}

// 轴刻度用紧凑单位：金额类指标动辄上亿，全位数会把轴标签挤爆。
// 注意只用于「轴刻度」，tooltip 上显示的仍是原始值，两者不必一样。
export function compactNumber(v: number): string {
  if (!Number.isFinite(v)) return '';
  const trim = (s: string) => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);
  const a = Math.abs(v);
  if (a >= 1e8) return `${trim((v / 1e8).toFixed(2))}亿`;
  if (a >= 1e4) return `${trim((v / 1e4).toFixed(2))}万`;
  return v.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

export default function ChartView({
  data,
  type,
  series,
  stacked,
  height = 340,
  xCount = 0,
  xLabel,
  yLabel,
}: Props) {
  // 轴标签防重叠：类目多时自动旋转 + 自动隐藏，再多就上滑块
  const axis: Record<string, unknown> = {
    x: {
      title: xLabel || null,
      labelAutoRotate: true,
      labelAutoHide: true,
    },
    y: {
      title: yLabel || null,
      labelFormatter: (v: unknown) => compactNumber(Number(v)),
    },
  };
  const slider = xCount > 30 ? { x: {} } : undefined;

  // tooltip 显示原始值：后端把 Decimal 转成字符串就是为了保精度，
  // 这里若再显示成 float64，tooltip 和表格会对不上。
  const tooltip = {
    title: (d: ChartPoint) => d.x,
    items: [(d: ChartPoint) => ({ name: d.series, value: d.raw || '—' })],
  };

  if (type === 'pie') {
    const first = series[0];
    const pieData = data.filter((d) => d.series === first).map((d) => ({ x: d.x, y: d.y ?? 0, raw: d.raw }));
    const cfg: Record<string, unknown> = {
      data: pieData,
      angleField: 'y',
      colorField: 'x',
      height,
      autoFit: true,
      label: { text: (d: { x: string }) => d.x, position: 'outside' },
      legend: { position: 'right' },
      tooltip: { items: [(d: { x: string; raw: string }) => ({ name: d.x, value: d.raw || '—' })] },
    };
    return <LPie {...cfg} />;
  }

  if (type === 'dual') {
    // 双 Y 轴：两条轴各自独立缩放，解决「消耗」和「点击数」差几个数量级的问题
    const two = series.slice(0, 2);
    const wide = new Map<string, Record<string, unknown>>();
    for (const p of data) {
      if (!two.includes(p.series)) continue;
      const row = wide.get(p.x) ?? { x: p.x };
      row[p.series] = p.y ?? 0;
      wide.set(p.x, row);
    }
    const cfg: Record<string, unknown> = {
      data: [...wide.values()],
      xField: 'x',
      yField: two,
      height,
      autoFit: true,
      axis,
      slider,
      legend: { position: 'top' },
      tooltip: { title: (d: { x: string }) => d.x },
    };
    return <LDualAxes {...cfg} />;
  }

  const cfg: Record<string, unknown> = {
    data,
    xField: 'x',
    yField: 'y',
    seriesField: 'series',
    height,
    autoFit: true,
    smooth: type === 'line',
    // NULL 必须断开，不能连成 0，否则「没数据」看起来像「数据为 0」
    connectNulls: false,
    stack: type !== 'line' ? !!stacked : undefined,
    axis,
    slider,
    tooltip,
    legend: series.length > 1 ? { position: 'top' } : false,
  };

  if (type === 'column') return <LColumn {...cfg} />;
  if (type === 'bar') return <LBar {...cfg} />;
  if (type === 'area') return <LArea {...cfg} />;
  return <LLine {...cfg} />;
}
