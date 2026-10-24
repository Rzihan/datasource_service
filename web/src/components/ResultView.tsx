import { Suspense, lazy, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import {
  Alert,
  App,
  Button,
  Empty,
  Modal,
  Select,
  Skeleton,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { DownloadOutlined, FullscreenOutlined } from '@ant-design/icons';
import type { ChartPoint, ChartType } from './ChartView';
import type { QueryResult, StringMap } from '../types';

// 图表库体积很大（gzip 400KB+），懒加载，不进首屏 chunk。
// 上面的 import type 只带类型，编译后会被擦掉，不会把图表库拉进来。
const ChartView = lazy(() => import('./ChartView'));

// 系列数硬顶：多指标 × 多分组值很容易组合出几十条线，
// 画出来没人看得懂，所以按总量取前 N 条并明确提示被截断。
const MAX_SERIES = 12;

const CHART_TYPES: Array<{ value: ChartType; label: string }> = [
  { value: 'line', label: '折线图' },
  { value: 'column', label: '柱状图' },
  { value: 'bar', label: '条形图' },
  { value: 'area', label: '面积图' },
  { value: 'pie', label: '饼图' },
  { value: 'dual', label: '双 Y 轴' },
];

interface Props {
  result: QueryResult | null;
  dims: string[];
  metrics: string[];
  labelMap: StringMap;
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

// 单元格渲染：Decimal 在后端已转成字符串保精度，这里原样展示，不做数值转换。
function renderCell(value: unknown) {
  if (value === null || value === undefined) {
    return <Typography.Text type="secondary">NULL</Typography.Text>;
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}

function display(name: string, labelMap: StringMap) {
  return labelMap[name] ? `${labelMap[name]}（${name}）` : name;
}

// 只认真正的数字：NULL / 空串 / 非数字一律返回 null，
// 而不是退化成 0 ——「没数」和「数为 0」在图上必须是两回事。
export function toNumber(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const s = String(raw).trim().replace(/,/g, '');
  if (s === '' || s.toUpperCase() === 'NULL') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export default function ResultView({ result, dims, metrics, labelMap }: Props) {
  const { message } = App.useApp();
  const [tab, setTab] = useState<'table' | 'chart'>('table');
  const [xField, setXField] = useState<string>('');
  const [yFields, setYFields] = useState<string[]>([]);
  const [groupField, setGroupField] = useState<string>('');
  const [chartType, setChartType] = useState<ChartType>('line');
  const [stacked, setStacked] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const chartBoxRef = useRef<HTMLDivElement>(null);
  const fullBoxRef = useRef<HTMLDivElement>(null);

  const columns = useMemo(() => {
    if (!result) return [];
    return result.columns.map((c, i) => ({
      title: columnTitle(c.name, labelMap),
      dataIndex: `c${i}`,
      key: `c${i}`,
      ellipsis: true,
      render: (v: unknown) => renderCell(v),
    }));
  }, [result, labelMap]);

  const dataSource = useMemo(() => {
    if (!result) return [];
    return result.rows.map((row, i) => {
      const obj: Record<string, unknown> = { key: i };
      row.forEach((v, idx) => {
        obj[`c${idx}`] = v;
      });
      return obj;
    });
  }, [result]);

  const colNames = useMemo(() => (result?.columns ?? []).map((c) => c.name), [result]);

  // 换数据源重查后，上次选的字段可能已经不在结果里了。这里做一次「有效化」：
  // 失效就回落到第一个可用字段，避免出现一片空白的图却不给任何提示。
  const dimCols = useMemo(() => dims.filter((d) => colNames.includes(d)), [dims, colNames]);
  const metricCols = useMemo(() => metrics.filter((m) => colNames.includes(m)), [metrics, colNames]);
  const resolvedX = xField && dimCols.includes(xField) ? xField : dimCols[0] ?? '';
  const resolvedYs = useMemo(() => {
    const picked = yFields.filter((m) => metricCols.includes(m));
    return picked.length > 0 ? picked : metricCols.slice(0, 1);
  }, [yFields, metricCols]);
  const resolvedGroup =
    groupField && dimCols.includes(groupField) && groupField !== resolvedX ? groupField : '';

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
    return { points: kept, series: names, seriesTruncated: truncated, xCount: new Set(kept.map((p) => p.x)).size };
  }, [result, colNames, resolvedX, resolvedYs, resolvedGroup, labelMap]);

  const pieAvailable = resolvedYs.length === 1 && !resolvedGroup;
  const dualAvailable = resolvedYs.length === 2 && !resolvedGroup;
  // 图表类型会被引擎纠正，纠正后的值就是真正画出来的类型：
  //   - 饼图只支持单指标不分组；双 Y 轴只支持两个指标不分组
  //   - 没有维度时只有一个「汇总」类目，折线/面积画出来是空的，降级成柱状
  const effectiveType: ChartType = (() => {
    if ((chartType === 'pie' && !pieAvailable) || (chartType === 'dual' && !dualAvailable)) return 'column';
    if (dimCols.length === 0 && (chartType === 'line' || chartType === 'area')) return 'column';
    return chartType;
  })();

  const chartNode = (boxRef: RefObject<HTMLDivElement>, h: number) => (
    <div ref={boxRef}>
      <ChartView
        data={points}
        type={effectiveType}
        series={series}
        stacked={stacked}
        height={h}
        xCount={xCount}
        xLabel={resolvedX ? labelMap[resolvedX] || resolvedX : '汇总'}
        yLabel={series.length === 1 ? series[0] : undefined}
      />
    </div>
  );

  // 纯前端导出：数据已经在内存里了，不需要后端再给一个导出接口
  const downloadCSV = () => {
    if (!result) return;
    const head = result.columns.map((c) => csvCell(c.name)).join(',');
    const body = result.rows.map((r) => r.map(csvCell).join(','));
    // BOM：不加的话 Excel 打开中文会乱码
    const blob = new Blob(['﻿' + [head, ...body].join('\r\n')], {
      type: 'text/csv;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `query-result-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
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
    a.download = `chart-${Date.now()}.png`;
    a.click();
  };

  if (!result) {
    return <Empty style={{ marginTop: 80 }} description="选择维度与指标后点击「查数」" />;
  }

  return (
    <div>
      <Space style={{ marginBottom: 12, justifyContent: 'space-between', display: 'flex' }} wrap>
        <Space wrap>
          <Typography.Text type="secondary">
            共 {result.row_count} 行 · 耗时 {result.elapsed_ms} ms
          </Typography.Text>
          {result.truncated && <Tag color="warning">结果已截断至上限</Tag>}
        </Space>
        <Button size="small" icon={<DownloadOutlined />} onClick={downloadCSV}>
          下载 CSV
        </Button>
      </Space>

      <Tabs
        activeKey={tab}
        onChange={(k) => setTab(k as 'table' | 'chart')}
        items={[
          {
            key: 'table',
            label: '表格',
            children: (
              <Table
                size="small"
                columns={columns}
                dataSource={dataSource}
                scroll={{ x: 'max-content' }}
                pagination={{
                  defaultPageSize: 20,
                  showSizeChanger: true,
                  pageSizeOptions: [20, 50, 100, 200],
                  showTotal: (t) => `共 ${t} 行`,
                }}
              />
            ),
          },
          {
            key: 'chart',
            label: '图表',
            children: (
              <div>
                <Space style={{ marginBottom: 12 }} wrap>
                  <Select
                    style={{ width: 150 }}
                    placeholder="X 轴（维度）"
                    value={resolvedX || undefined}
                    onChange={setXField}
                    disabled={dimCols.length === 0}
                    options={dimCols.map((d) => ({ value: d, label: display(d, labelMap) }))}
                  />
                  <Select
                    style={{ width: 150 }}
                    allowClear
                    placeholder="分组维度（可选）"
                    value={resolvedGroup || undefined}
                    onChange={(v) => setGroupField(v ?? '')}
                    disabled={dimCols.filter((d) => d !== resolvedX).length === 0}
                    options={dimCols
                      .filter((d) => d !== resolvedX)
                      .map((d) => ({ value: d, label: display(d, labelMap) }))}
                  />
                  <Select
                    mode="multiple"
                    style={{ minWidth: 180 }}
                    placeholder="Y 轴（指标）"
                    value={resolvedYs}
                    onChange={setYFields}
                    disabled={metricCols.length === 0}
                    maxTagCount={2}
                    options={metricCols.map((m) => ({ value: m, label: display(m, labelMap) }))}
                  />
                  <Select
                    style={{ width: 120 }}
                    value={chartType}
                    onChange={setChartType}
                    options={CHART_TYPES.map((t) => ({
                      value: t.value,
                      label: t.label,
                      disabled:
                        (t.value === 'pie' && !pieAvailable) || (t.value === 'dual' && !dualAvailable),
                    }))}
                  />
                  {['column', 'bar', 'area'].includes(effectiveType) && (
                    <Space size={4}>
                      <Typography.Text type="secondary">堆叠</Typography.Text>
                      <Switch size="small" checked={stacked} onChange={setStacked} />
                    </Space>
                  )}
                  <Button size="small" icon={<FullscreenOutlined />} onClick={() => setFullscreen(true)}>
                    全屏
                  </Button>
                  <Button size="small" icon={<DownloadOutlined />} onClick={downloadPng}>
                    PNG
                  </Button>
                </Space>

                {dimCols.length === 0 && (
                  <Alert
                    type="info"
                    showIcon
                    style={{ marginBottom: 12 }}
                    message="本次查询没有选维度，X 轴按「汇总」展示各指标的值"
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
                {chartType === 'pie' && !pieAvailable && (
                  <Alert
                    type="warning"
                    showIcon
                    style={{ marginBottom: 12 }}
                    message="饼图只支持单个指标且不分组，已按柱状图展示"
                  />
                )}

                {series.length > 0 ? (
                  <Suspense fallback={<Skeleton active paragraph={{ rows: 8 }} />}>
                    {chartNode(chartBoxRef, 340)}
                  </Suspense>
                ) : (
                  <Empty description="图表需要至少一个指标，请在左侧勾选指标后重新查数" />
                )}
              </div>
            ),
          },
        ]}
      />

      <Modal
        open={fullscreen}
        onCancel={() => setFullscreen(false)}
        footer={null}
        width="90vw"
        title="图表"
        destroyOnClose
      >
        {chartNode(fullBoxRef, 520)}
        <Space style={{ marginTop: 12 }}>
          <Button icon={<DownloadOutlined />} onClick={downloadPng}>
            导出 PNG
          </Button>
        </Space>
      </Modal>
    </div>
  );
}
