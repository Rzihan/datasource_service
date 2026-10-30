import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dayjs from 'dayjs';
import type { RefObject } from 'react';
import {
  Alert,
  App,
  Button,
  Empty,
  Modal,
  Segmented,
  Skeleton,
  Space,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { BulbOutlined, DownloadOutlined, FullscreenOutlined, FunctionOutlined } from '@ant-design/icons';
import type { ChartPoint, ChartType } from './ChartView';
import { buildShape, recommend } from '../utils/chartRecommend';
import type { ChartKind } from '../utils/chartRecommend';
import { toNumber } from '../utils/number';
import { columnDigits, formatNumber, formatScaled, numericText, parseScaled, sumColumn } from '../utils/format';
import type { ExprNode } from '../utils/expr';
import { evalExpression, parseExpression } from '../utils/expr';
import DerivedColumnModal from './DerivedColumnModal';
import type { QueryResult, StringMap } from '../types';

// 保持原有导出面：数值判定已挪到 utils/number，图表和推荐规则共用同一套。
export { toNumber };

// 图表库体积很大（gzip 400KB+），懒加载，不进首屏 chunk。
// 上面的 import type 只带类型，编译后会被擦掉，不会把图表库拉进来。
const ChartView = lazy(() => import('./ChartView'));

// 系列数硬顶：多指标 × 多分组值很容易组合出几十条线，
// 画出来没人看得懂，所以按总量取前 N 条并明确提示被截断。
const MAX_SERIES = 12;

// 派生列多是比值（CPC、点击率），两位小数会被抹成 0.05，四位才看得出差别。
const derivedFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 4 });

// 四个 tab：表格是默认，三个图各一种用途。不做更多类型——
// 类型越多越要用户理解「条形图和柱状图有什么区别」，收益远小于成本。
type TabKey = ChartKind;

const CHART_TABS: Array<{ key: ChartType; label: string }> = [
  { key: 'column', label: '柱状图' },
  { key: 'line', label: '折线图' },
  { key: 'pie', label: '饼图' },
];

const KIND_LABEL: Record<ChartKind, string> = {
  table: '表格',
  column: '柱状图',
  line: '折线图',
  pie: '饼图',
};

// 导出时写进文件头的「口径」。数据一旦离开页面就失去了上下文，
// 只给一列数字的 CSV，收件人无法判断它筛的是哪段时间、哪个渠道。
export interface ExportMeta {
  dataset: string;
  dims: string[];
  metrics: string[];
  filterText: string;
  orderText: string;
  limit: number;
}

interface Props {
  result: QueryResult | null;
  dims: string[];
  metrics: string[];
  labelMap: StringMap;
  exportMeta: ExportMeta;
  // 不能逐行相加的指标（比率 / 均值 / 去重类）。合计行对它们显示「—」，
  // 否则有效率会加出 1622% 这种一眼错的数——比不显示更糟。
  nonAdditive?: string[];
}

// 表头显示中文含义，原始字段名收进 Tooltip，方便对照 SQL 和下游对接
function columnTitle(name: string, labelMap: StringMap) {
  const label = labelMap[name];
  if (!label) return name;
  return (
    <Tooltip title={`字段：${name}`}>
      <span>{label}</span>
    </Tooltip>
  );
}

// 单元格渲染：指标列按数值格式化（千分位 + 列内统一小数位），维度列原样展示。
// Decimal 在后端已转成字符串保精度，格式化也走字符串/定点，不经过 float。
function renderCell(value: unknown, numeric: boolean, digits: number) {
  if (value === null || value === undefined) {
    return <Typography.Text type="secondary">NULL</Typography.Text>;
  }
  if (numeric) {
    const text = formatNumber(value, digits);
    if (text !== null) {
      // tabular-nums：等宽数字，纵向扫一列时位数才对得齐
      return <span style={{ fontVariantNumeric: 'tabular-nums' }}>{text}</span>;
    }
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export default function ResultView({ result, dims, metrics, labelMap, exportMeta, nonAdditive = [] }: Props) {
  const { message } = App.useApp();
  // 默认落在表格：查数首先是要看到数，图只是可选的呈现方式。
  const [tab, setTab] = useState<TabKey>('table');
  const [fullscreen, setFullscreen] = useState(false);
  // 柱状图的排列方式。系列一多（比如 日期 × 渠道），分组柱会糊成一片，
  // 堆叠至少能回答「总量和构成」，所以给一个显式开关而不是替用户猜。
  const [stacked, setStacked] = useState(false);
  // 派生列：跟着这一次结果走，换查询就清空（列名可能完全不同）
  const [derived, setDerived] = useState<Array<{ name: string; expr: string; node: ExprNode }>>([]);
  const [derivedOpen, setDerivedOpen] = useState(false);
  useEffect(() => {
    setDerived([]);
  }, [result]);
  const chartBoxRef = useRef<HTMLDivElement>(null);
  const fullBoxRef = useRef<HTMLDivElement>(null);

  // 每列是不是数值、小数位保留几位，都按「这一列的值」定，不按字段类型猜：
  // 指标列也可能返回非数值（配置写错时），那时退回原样显示，不静默变成 0。
  const columnMeta = useMemo(() => {
    if (!result) return [];
    return result.columns.map((c, i) => {
      const values = result.rows.map((r) => r[i]);
      const isMetric = metrics.includes(c.name);
      const numeric = isMetric && values.some((v) => numericText(v) !== null);
      return { name: c.name, numeric, digits: numeric ? columnDigits(values) : 0 };
    });
  }, [result, metrics]);

  // 排序比较器：表头点击与导出排序共用一套，导出的顺序才会和屏幕上一致。
  const compareAt = useCallback(
    (i: number, a: Record<string, unknown>, b: Record<string, unknown>) => {
      const m = columnMeta[i];
      const av = a[`c${i}`];
      const bv = b[`c${i}`];
      if (!m) return 0;
      if (m.numeric) {
        const x = parseScaled(av, m.digits);
        const y = parseScaled(bv, m.digits);
        if (x === null || y === null) return x === y ? 0 : x === null ? -1 : 1;
        return x < y ? -1 : x > y ? 1 : 0;
      }
      return String(av ?? '').localeCompare(String(bv ?? ''), 'zh-CN');
    },
    [columnMeta],
  );

  const columns = useMemo(() => {
    return columnMeta.map((m, i) => ({
      title: columnTitle(m.name, labelMap),
      dataIndex: `c${i}`,
      key: `c${i}`,
      ellipsis: true,
      align: (m.numeric ? 'right' : 'left') as 'right' | 'left',
      render: (v: unknown) => renderCell(v, m.numeric, m.digits),
      // 本地排序：数据已经在内存里，想看「谁最高」不该回左边重设排序再查一遍。
      // 数值按定点大小比较（不经过 float），维度按中文拼音序。
      sorter: (a: Record<string, unknown>, b: Record<string, unknown>) => compareAt(i, a, b),
    }));
  }, [columnMeta, labelMap, compareAt]);

  // 合计行：只对当前返回的全部行求和（不是当前分页），有分组才显示。
  // 两个局限写进 tooltip 而不是藏着：截断时只是部分合计；去重类指标逐行相加会重复计数。
  const summaryRow = useMemo(() => {
    if (!result || result.rows.length < 2) return null;
    if (!columnMeta.some((m) => m.numeric)) return null;
    const nonAdditiveSet = new Set(nonAdditive);
    const sumNote = [
      `对当前返回的 ${result.rows.length} 行求和`,
      result.truncated ? '（结果已截断，这只是部分合计）' : '',
      '比率 / 均值 / 去重类指标不参与合计，显示为 —',
    ].join('；');
    return (
      <Table.Summary fixed>
        <Table.Summary.Row>
          {columnMeta.map((m, i) => (
            <Table.Summary.Cell key={i} index={i} align={m.numeric ? 'right' : 'left'}>
              {i === 0 ? (
                <Tooltip title={sumNote}>
                  <Typography.Text strong style={{ cursor: 'help' }}>
                    合计
                  </Typography.Text>
                </Tooltip>
              ) : m.numeric && !nonAdditiveSet.has(m.name) ? (
                <Typography.Text strong style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {formatScaled(sumColumn(result.rows.map((r) => r[i]), m.digits), m.digits)}
                </Typography.Text>
              ) : nonAdditiveSet.has(m.name) ? (
                <Tooltip title={`「${m.name}」不是可累加的指标（比率/均值/去重），逐行相加没有含义`}>
                  <Typography.Text type="secondary" style={{ cursor: 'help' }}>
                    —
                  </Typography.Text>
                </Tooltip>
              ) : null}
            </Table.Summary.Cell>
          ))}
          {derived.map((d, di) => (
            <Table.Summary.Cell key={`d${di}`} index={columnMeta.length + di} align="right">
              <Tooltip title={`「${d.name}」是比值，逐行相加没有含义，所以不合计`}>
                <Typography.Text type="secondary" style={{ cursor: 'help' }}>
                  —
                </Typography.Text>
              </Tooltip>
            </Table.Summary.Cell>
          ))}
        </Table.Summary.Row>
      </Table.Summary>
    );
  }, [result, columnMeta, derived, nonAdditive]);

  const colNames = useMemo(() => (result?.columns ?? []).map((c) => c.name), [result]);

  const dimCols = useMemo(() => dims.filter((d) => colNames.includes(d)), [dims, colNames]);
  const metricCols = useMemo(() => metrics.filter((m) => colNames.includes(m)), [metrics, colNames]);

  // 图表字段完全由「查询时勾了什么」决定，不再让用户在结果区二次圈选：
  //   第 1 个维度 → X 轴，第 2 个维度 → 分组，所有指标 → Y 轴。
  // 想换口径回查询构建器改，避免同一份数据出现两套互相打架的字段选择。
  const resolvedX = dimCols[0] ?? '';
  const resolvedGroup = dimCols.find((d) => d !== resolvedX) ?? '';
  const resolvedYs = metricCols;

  // X 轴是不是时间：后端默认按指标降序返回（TopN 口径），直接拿去画折线，
  // 趋势会被排序口径打乱——看着像「忽高忽低」，其实是降序排列。
  // 这里只做格式识别，不做类型推断：认得 ISO 日期 / 日期时间就够了。
  const xIsTemporal = useMemo(() => {
    if (!result || !resolvedX) return false;
    const idx = colNames.indexOf(resolvedX);
    if (idx < 0) return false;
    const rx = /^\d{4}-\d{2}(-\d{2})?([ T]\d{2}:\d{2}(:\d{2})?)?$/;
    const values = result.rows.map((r) => r[idx]).filter((v) => v !== null && v !== undefined);
    return values.length > 0 && values.every((v) => rx.test(String(v)));
  }, [result, resolvedX, colNames]);

  // 派生列的值：逐行 = 表达式在「本次结果的列」上求值。
  // 只允许引用基础列，不允许多层派生互相引用——那种依赖图在表里看不出来。
  const derivedData = useMemo(() => {
    if (!result) return [] as Array<Array<number | null>>;
    return derived.map((d) =>
      result.rows.map((row) =>
        evalExpression(d.node, (name) => {
          const idx = colNames.indexOf(name);
          return idx >= 0 ? toNumber(row[idx]) : null;
        }),
      ),
    );
  }, [result, derived, colNames]);

  // 记录表头的排序状态：antd 自己排序只影响它渲染的那份副本，
  // 导出得按同样的口径再排一遍，否则「看到的」和「导出的」是两个顺序。
  const [sortInfo, setSortInfo] = useState<{ key: string; order: 'ascend' | 'descend' } | null>(null);


  const derivedColumns = useMemo(
    () =>
      derived.map((d, di) => ({
        title: (
          <Tooltip title={`计算列：${d.expr}`}>
            <span>{d.name}</span>
          </Tooltip>
        ),
        dataIndex: `d${di}`,
        key: `d${di}`,
        align: 'right' as const,
        ellipsis: true,
        render: (v: number | null) =>
          v === null ? (
            <Typography.Text type="secondary">NULL</Typography.Text>
          ) : (
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>{derivedFormat.format(v)}</span>
          ),
        sorter: (a: Record<string, unknown>, b: Record<string, unknown>) =>
          ((a[`d${di}`] as number | null) ?? -Infinity) - ((b[`d${di}`] as number | null) ?? -Infinity),
      })),
    [derived],
  );

  const dataSource = useMemo(() => {
    if (!result) return [];
    const xIdx = resolvedX ? colNames.indexOf(resolvedX) : -1;
    const rows = result.rows.map((row, i) => {
      const obj: Record<string, unknown> = { key: i };
      row.forEach((v, idx) => {
        obj[`c${idx}`] = v;
      });
      return obj;
    });
    // 时间维度按时间升序展示：表格和图必须讲同一个顺序，
    // 否则「表里第一行」和「图里最左边」是两个不同的日期。
    if (xIsTemporal && xIdx >= 0) {
      rows.sort((a, b) => String(a[`c${xIdx}`] ?? '').localeCompare(String(b[`c${xIdx}`] ?? '')));
    }
    derivedData.forEach((col, di) => {
      rows.forEach((row, i) => {
        row[`d${di}`] = col[i];
      });
    });
    return rows;
  }, [result, resolvedX, colNames, xIsTemporal, derivedData]);

  const exportRows = useMemo(() => {
    const rows = [...dataSource];
    if (!sortInfo) return rows;
    const isDerived = sortInfo.key.startsWith('d');
    const idx = Number(sortInfo.key.slice(1));
    rows.sort((a, b) => {
      let r: number;
      if (isDerived) r = ((a[sortInfo.key] as number | null) ?? -Infinity) - ((b[sortInfo.key] as number | null) ?? -Infinity);
      else r = compareAt(idx, a, b);
      return sortInfo.order === 'ascend' ? r : -r;
    });
    return rows;
  }, [dataSource, sortInfo, compareAt]);

  // 智能推荐：只看「结果长什么样」，与后端无关，纯前端推导。
  // 它只影响 tab 上的「推荐」标记，不会自动切走用户当前所在的 tab。
  const shape = useMemo(
    () =>
      result
        ? buildShape({ result, xField: resolvedX, groupField: resolvedGroup, yFields: resolvedYs })
        : null,
    [result, resolvedX, resolvedGroup, resolvedYs],
  );
  const recommendation = useMemo(() => (shape ? recommend(shape) : null), [shape]);

  const { points, series, seriesTruncated, xCount } = useMemo(() => {
    const empty = { points: [] as ChartPoint[], series: [] as string[], seriesTruncated: false, xCount: 0 };
    if (!result) return empty;
    const xIdx = resolvedX ? colNames.indexOf(resolvedX) : -1;
    const gIdx = resolvedGroup ? colNames.indexOf(resolvedGroup) : -1;
    const targets = resolvedYs.map((m) => ({ name: labelMap[m] || m, idx: colNames.indexOf(m) }));
    if (targets.length === 0) return empty;

    const all: ChartPoint[] = [];
    const sums = new Map<string, number>();
    for (const row of result.rows) {
      const x = xIdx >= 0 ? (row[xIdx] === null || row[xIdx] === undefined ? '(空值)' : String(row[xIdx])) : '汇总';
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
    let truncated = false;
    if (names.length > MAX_SERIES) {
      names = [...sums.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, MAX_SERIES)
        .map(([k]) => k);
      truncated = true;
    }
    const keep = new Set(names);
    const kept = all.filter((p) => keep.has(p.series));
    // 时间类 X 轴按时间升序；其余保持后端顺序（默认即按指标降序），
    // 柱子从高到低排，才看得出「谁是大头」。
    if (xIsTemporal) kept.sort((a, b) => a.x.localeCompare(b.x));
    return { points: kept, series: names, seriesTruncated: truncated, xCount: new Set(kept.map((p) => p.x)).size };
  }, [result, colNames, resolvedX, resolvedYs, resolvedGroup, labelMap, xIsTemporal]);

  // 某些图在当前字段组合下画不出来：直接把对应 tab 置灰并说明原因，
  // 而不是让用户点进去看到一张莫名其妙的图。
  // 堆叠只对「同一个指标按维度拆开」有意义。多个指标堆在一起是把
  // 消耗和点击数相加——量纲不同，加出来的数没有含义，图还很唬人。
  const canStack = !!resolvedGroup && resolvedYs.length === 1 && series.length > 1;

  const pieAvailable = resolvedYs.length === 1 && !resolvedGroup && xCount >= 3 && xCount <= 12;
  const lineAvailable = dimCols.length > 0;
  const unavailable = useMemo(() => {
    const map: Partial<Record<ChartType, string>> = {};
    if (!pieAvailable) map.pie = '饼图需要「单个指标、不分组」，且类目在 3~12 个之间';
    if (!lineAvailable) map.line = '折线图至少需要一个维度才能画趋势';
    return map;
  }, [pieAvailable, lineAvailable]);

  // 换了一份结果后可能不再具备堆叠条件，状态跟着收回，避免下次进来还是堆叠
  const stackActive = canStack && stacked;

  const chartNode = (boxRef: RefObject<HTMLDivElement>, h: number, type: ChartType) => (
    <div ref={boxRef}>
      <ChartView
        data={points}
        type={type}
        series={series}
        height={h}
        xCount={xCount}
        xLabel={resolvedX ? labelMap[resolvedX] || resolvedX : '汇总'}
        yLabel={series.length === 1 ? series[0] : undefined}
        stacked={type === 'column' && stackActive}
      />
    </div>
  );

  // 纯前端导出：数据已经在内存里了，不需要后端再给一个导出接口
  const downloadCSV = () => {
    if (!result) return;
    const stamp = dayjs().format('YYYYMMDD-HHmm');
    // 文件头写口径：这一份数据是怎么筛出来的，离开页面也说得清。
    // 用 # 开头，肉眼一眼能分出元信息；Excel / pandas 打开也不会丢。
    const meta = [
      `# 数据集：${exportMeta.dataset}`,
      `# 维度：${exportMeta.dims.join('、') || '无（汇总）'}`,
      `# 指标：${exportMeta.metrics.join('、') || '无'}`,
      `# 筛选：${exportMeta.filterText || '无'}`,
      `# 排序：${exportMeta.orderText} · 返回上限 ${exportMeta.limit} 行`,
      `# 导出时间：${dayjs().format('YYYY-MM-DD HH:mm')} · 共 ${result.row_count} 行${
        result.truncated ? '（结果已截断，不是全量）' : ''
      }`,
      ...(derived.length > 0 ? [`# 计算列：${derived.map((d) => `${d.name} = ${d.expr}`).join('；')}`] : []),
    ];
    const head = [...result.columns.map((c) => csvCell(c.name)), ...derived.map((d) => csvCell(d.name))].join(',');
    // 导出的行序 = 当前表格的顺序（含表头排序），而不是后端返回顺序
    const body = exportRows.map((row) => {
      const base = result.columns.map((_, i) => csvCell(row[`c${i}`]));
      // 计算列保留 4 位：它是前端算出来的 float，原样导出会出现 0.04756712330684366 这种噪声
      const extra = derived.map((_, di) => {
        const v = row[`d${di}`] as number | null | undefined;
        return v === null || v === undefined ? '' : csvCell(v.toFixed(4));
      });
      return [...base, ...extra].join(',');
    });
    // BOM：不加的话 Excel 打开中文会乱码
    const blob = new Blob(['﻿' + [...meta, '', head, ...body].join('\r\n')], {
      type: 'text/csv;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    // 文件名自带数据集与时间：多人互传时不用再猜「query-result-1730」是哪份
    const safe = (t: string) => t.replace(/[\\/:*?"<>|\s]+/g, '');
    a.download = `${safe(exportMeta.dataset.split(' · ')[0]) || 'query'}_${safe(exportMeta.dims.join('-')) || '汇总'}_${stamp}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const previewDerived = useCallback(
    (expr: string) => {
      if (!result || colNames.length === 0) return { error: '还没有查询结果', preview: '' };
      try {
        const node = parseExpression(expr, new Set(colNames));
        const row = result.rows[0];
        if (!row) return { error: '', preview: '当前结果没有行，无法预览' };
        const v = evalExpression(node, (name) => {
          const idx = colNames.indexOf(name);
          return idx >= 0 ? toNumber(row[idx]) : null;
        });
        return {
          error: '',
          preview:
            v === null
              ? '第一行结果为 NULL（缺值或除以 0），其它行可能有值'
              : `第一行：${derivedFormat.format(v)}`,
        };
      } catch (e) {
        return { error: (e as Error).message, preview: '' };
      }
    },
    [result, colNames],
  );

  const addDerived = (name: string, expr: string) => {
    try {
      const node = parseExpression(expr, new Set(colNames));
      setDerived((prev) => [...prev, { name, expr, node }]);
    } catch {
      // 弹窗里已经校验过，这里兜底不弹二次错误
    }
  };

  const downloadPng = () => {
    const box = fullscreen ? fullBoxRef.current : chartBoxRef.current;
    const canvas = box?.querySelector('canvas') as HTMLCanvasElement | null;
    if (!canvas) {
      message.warning('图表还没渲染出来，稍等一下再导出');
      return;
    }
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = `chart_${dayjs().format('YYYYMMDD-HHmm')}.png`;
    a.click();
  };

  if (!result) {
    return <Empty style={{ marginTop: 80 }} description="选择维度与指标后点击「查数」" />;
  }

  // tab 标签：推荐的那一个带「推荐」角标，不可用的整项置灰并在 tooltip 里说明原因
  const tabLabel = (key: ChartKind) => (
    <Tooltip
      title={
        key === 'table'
          ? undefined
          : unavailable[key]
            ? unavailable[key]
            : recommendation?.type === key
              ? `${recommendation.headline} · ${recommendation.reason}`
              : undefined
      }
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        {KIND_LABEL[key]}
        {recommendation?.type === key && (
          <Tag color="success" style={{ marginInlineEnd: 0, borderRadius: 999, fontSize: 11, lineHeight: '16px' }}>
            推荐
          </Tag>
        )}
      </span>
    </Tooltip>
  );

  const chartTab = (type: ChartType) => {
    if (unavailable[type]) {
      return (
        <div>
          <Alert type="warning" showIcon style={{ marginBottom: 12 }} message={`${KIND_LABEL[type]}当前不可用`} description={unavailable[type]} />
          <Empty description="切回表格看原始数据，或换一个图" />
        </div>
      );
    }
    return (
      <div>
        <Space style={{ marginBottom: 12 }} wrap>
          <Button size="small" icon={<FullscreenOutlined />} onClick={() => setFullscreen(true)}>
            全屏
          </Button>
          <Button size="small" icon={<DownloadOutlined />} onClick={downloadPng}>
            PNG
          </Button>
          {type === 'column' && canStack && (
            <Segmented
              size="small"
              value={stackActive ? 'stack' : 'group'}
              onChange={(v) => setStacked(v === 'stack')}
              options={[
                { label: '分组', value: 'group' },
                { label: '堆叠', value: 'stack' },
              ]}
            />
          )}
          {type === 'column' && canStack && !stackActive && series.length >= 4 && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              系列较多，堆叠更易看总量
            </Typography.Text>
          )}
        </Space>

        {dimCols.length === 0 && (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message="本次查询没有选维度，横轴按「汇总」展示各指标的值"
          />
        )}
        {seriesTruncated && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message={`系列数为 ${series.length} 已超上限，仅展示总量最大的 ${MAX_SERIES} 个系列`}
            description="减少指标数量或去掉分组维度可以看全"
          />
        )}

        {series.length > 0 ? (
          <Suspense fallback={<Skeleton active paragraph={{ rows: 8 }} />}>
            {chartNode(chartBoxRef, 340, type)}
          </Suspense>
        ) : (
          <Empty description="画图需要至少一个指标，请在左侧勾选指标后重新查数" />
        )}
      </div>
    );
  };

  return (
    <div>
      <Space style={{ marginBottom: 12, justifyContent: 'space-between', display: 'flex' }} wrap>
        <Space wrap>
          <Typography.Text type="secondary">
            共 {result.row_count} 行 · 耗时 {result.elapsed_ms} ms
          </Typography.Text>
          {result.truncated && <Tag color="warning">结果已截断至上限</Tag>}
        </Space>
        <Space size={8}>
          <Tooltip title="用已有列做四则运算，生成 CPC 之类的比率指标">
            <Button size="small" icon={<FunctionOutlined />} onClick={() => setDerivedOpen(true)}>
              计算列
            </Button>
          </Tooltip>
          <Button size="small" icon={<DownloadOutlined />} onClick={downloadCSV}>
            下载 CSV
          </Button>
        </Space>
      </Space>

      {recommendation && (
        <Space size={6} style={{ marginBottom: 8 }} wrap>
          <BulbOutlined style={{ color: '#d48806' }} />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            推荐用
            <Typography.Text strong style={{ fontSize: 12 }}>
              {KIND_LABEL[recommendation.type]}
            </Typography.Text>
            呈现：{recommendation.headline}，{recommendation.reason}
          </Typography.Text>
        </Space>
      )}

      <Tabs
        activeKey={tab}
        onChange={(k) => setTab(k as TabKey)}
        items={[
          {
            key: 'table',
            label: tabLabel('table'),
            children: (
              <Table
                size="small"
                columns={[...columns, ...derivedColumns]}
                dataSource={dataSource}
                scroll={{ x: 'max-content' }}
                summary={() => summaryRow}
                onChange={(_pagination, _filters, sorter) => {
                  const single = Array.isArray(sorter) ? sorter[0] : sorter;
                  const key = single?.order ? String(single.columnKey ?? '') : '';
                  setSortInfo(key ? { key, order: single.order as 'ascend' | 'descend' } : null);
                }}
                pagination={{
                  defaultPageSize: 20,
                  showSizeChanger: true,
                  pageSizeOptions: [20, 50, 100, 200],
                  showTotal: (t) => `共 ${t} 行`,
                }}
              />
            ),
          },
          ...CHART_TABS.map((t) => ({
            key: t.key,
            label: tabLabel(t.key),
            disabled: !!unavailable[t.key],
            children: chartTab(t.key),
          })),
        ]}
      />

      {derived.length > 0 && (
        <Space size={4} wrap style={{ marginTop: 8 }}>
          {derived.map((d, di) => (
            <Tag
              key={`${d.name}-${di}`}
              closable
              onClose={(e) => {
                e.preventDefault();
                setDerived((prev) => prev.filter((_, i) => i !== di));
              }}
            >
              {d.name} = {d.expr}
            </Tag>
          ))}
        </Space>
      )}

      <DerivedColumnModal
        open={derivedOpen}
        onClose={() => setDerivedOpen(false)}
        fields={columnMeta.map((m) => ({ name: m.name, label: labelMap[m.name] || m.name }))}
        onPreview={previewDerived}
        onAdd={addDerived}
      />

      <Modal
        open={fullscreen && tab !== 'table'}
        onCancel={() => setFullscreen(false)}
        footer={null}
        width="90vw"
        title={tab === 'table' ? '图表' : KIND_LABEL[tab]}
        destroyOnHidden
      >
        {tab !== 'table' && chartNode(fullBoxRef, 520, tab)}
        <Space style={{ marginTop: 12 }}>
          <Button icon={<DownloadOutlined />} onClick={downloadPng}>
            导出 PNG
          </Button>
        </Space>
      </Modal>
    </div>
  );
}
