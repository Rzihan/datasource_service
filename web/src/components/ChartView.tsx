import { Column, Line, Pie } from '@ant-design/charts';
import type { FC } from 'react';

// G2 v5 的配置项非常宽（且版本间变动大），逐项对齐类型不划算。
// 这里把组件放宽成「任意 props」，配置对象用 Record 承载，既过得了 tsc，
// 也不会因为某个配置名拼错就整块编译失败——代价是配置项只能靠运行时验证。
type LooseChart = FC<Record<string, unknown>>;
const LLine = Line as unknown as LooseChart;
const LColumn = Column as unknown as LooseChart;
const LPie = Pie as unknown as LooseChart;

// 图表的数据点是「长表」：一行 = X 类目 × 一个系列 的一个点。
// 用长表而不是宽表，是为了让「多指标」和「按第二维度分组」走同一条构建路径。
export interface ChartPoint {
  x: string; // X 轴类目，NULL 已转成「(空值)」
  series: string; // 系列名：指标名，或「分组值 · 指标名」
  y: number | null; // 画图用。NULL 保持 null，绝不当成 0
  raw: string; // 后端返回的原始值，tooltip 用它与表格对齐
}

// 图表类型就是页面上的三个图 tab，外加表格。刻意不做柱状之外的变形：
// 类型越多，用户越要理解「条形图和柱状图有什么区别」，收益远小于成本。
export type ChartType = 'column' | 'line' | 'pie';

interface Props {
  data: ChartPoint[];
  type: ChartType;
  series: string[];
  height?: number;
  xCount?: number; // X 类目数，过多时加 slider
  xLabel?: string;
  yLabel?: string;
  // 柱状图的排列方式：分组（比较单个值）或堆叠（看总量构成）
  stacked?: boolean;
}

// 轴标签压缩：ISO 日期只保留月-日。
// 20 个「2026-10-01」竖着排会占掉半张图，而年份在同一个查询里几乎总是相同。
function shortAxisLabel(v: unknown): string {
  const s = String(v ?? '');
  const m = /^\d{4}-(\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/.exec(s);
  if (m) return m[2] ? `${m[1]} ${m[2]}` : m[1];
  return s;
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
  height = 340,
  xCount = 0,
  xLabel,
  yLabel,
  stacked = false,
}: Props) {
  // 轴标签防重叠：宁可少显示几个，也不竖排。
  // 旋转 90° 的标签要歪头读，20 个类目时基本等于没有标签；
  // 自动隐藏 + 缩短日期格式，剩下的仍然可读，tooltip 里有完整值。
  const xAxis: Record<string, unknown> = {
    title: xLabel || null,
    labelAutoRotate: false,
    labelAutoHide: true,
    labelAutoHideGap: 8,
    labelFormatter: shortAxisLabel,
  };
  const yAxis: Record<string, unknown> = {
    title: yLabel || null,
    labelFormatter: (v: unknown) => compactNumber(Number(v)),
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
    // 饼图看的是占比，光给绝对值等于要人自己在脑子里除一遍。
    // 占比在前端算：数据本来就在内存里，后端不该为展示口径再改接口。
    // 总量为 0 或含负数导致占比失去意义时，退回只显示数值。
    const total = pieData.reduce((s, d) => s + d.y, 0);
    const pct = (y: number) => (total > 0 ? `${((y / total) * 100).toFixed(1)}%` : null);
    return (
      <LPie
        data={pieData}
        angleField="y"
        colorField="x"
        height={height}
        autoFit
        label={{ text: (d: { x: string; raw: string }) => d.x, position: 'outside' }}
        legend={{ position: 'right' }}
        tooltip={{
          items: [
            (d: { x: string; y: number; raw: string }) => {
              const value = d.raw || '—';
              const p = pct(d.y);
              return { name: d.x, value: p ? `${value}（占比 ${p}）` : value };
            },
          ],
        }}
      />
    );
  }

  const cfg: Record<string, unknown> = {
    data,
    xField: 'x',
    yField: 'y',
    // G2 v5 用 colorField 做颜色分组，v4 的 seriesField 在这里不生效：
    // 不设的话所有系列同色，图例永远只有一个条目。
    colorField: 'series',
    height,
    autoFit: true,
    smooth: type === 'line',
    // NULL 必须断开，不能连成 0，否则「没数据」看起来像「数据为 0」
    connectNulls: false,
    axis: { x: xAxis, y: yAxis },
    slider,
    tooltip,
    // 图例换行而不是被压扁：8 条系列挤在一行时每条只剩几个像素，
    // 颜色对不上名字，图例就白放了。
    legend:
      series.length > 1
        ? { position: 'top', layout: { justifyContent: 'flex-start', flexWrap: 'wrap' } }
        : false,
  };

  if (type === 'column') {
    // 多系列必须显式 dodge：否则每条都按整个类目宽度画，后画的盖住先画的，
    // 看着像「只有一个颜色」。@ant-design/plots v2 不认 group 属性，只能用 transform。
    if (series.length > 1) cfg.transform = stacked ? [{ type: 'stackY' }] : [{ type: 'dodgeX' }];
    // 系列少、类目也少时柱子会铺满整格，糊成一条色块，用 band padding 收窄
    if (series.length <= 2) cfg.scale = { x: { padding: 0.6 } };
    return <LColumn {...cfg} />;
  }
  return <LLine {...cfg} />;
}
