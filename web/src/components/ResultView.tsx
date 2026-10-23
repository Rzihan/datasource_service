import { Suspense, lazy, useMemo, useState } from 'react';
import { Empty, Select, Skeleton, Space, Table, Tabs, Tag, Tooltip, Typography } from 'antd';
import type { QueryResult, StringMap } from '../types';

const ChartView = lazy(() => import('./ChartView'));

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

export default function ResultView({ result, dims, metrics, labelMap }: Props) {
  const [tab, setTab] = useState<'table' | 'chart'>('table');
  const [xField, setXField] = useState<string>('');
  const [yField, setYField] = useState<string>('');
  const [chartType, setChartType] = useState<'line' | 'column'>('line');

  const columns = useMemo(() => {
    if (!result) return [];
    return result.columns.map((c, i) => ({
      title: columnTitle(c.name, labelMap),
      dataIndex: `c${i}`,
      key: `c${i}`,
      ellipsis: true,
      render: (v: unknown) => renderCell(v),
    }));
  }, [result]);

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

  const chartData = useMemo(() => {
    if (!result) return [];
    const xIdx = result.columns.findIndex((c) => c.name === xField);
    const yIdx = result.columns.findIndex((c) => c.name === yField);
    if (xIdx < 0 || yIdx < 0) return [];
    return result.rows.map((row) => {
      const raw = row[yIdx];
      const num = typeof raw === 'number' ? raw : Number(String(raw ?? '').replace(/,/g, ''));
      return {
        [xField]: String(row[xIdx] ?? ''),
        [yField]: Number.isNaN(num) ? 0 : num,
      };
    });
  }, [result, xField, yField]);

  const effectiveX = xField || dims[0] || '';
  const effectiveY = yField || metrics[0] || '';

  if (!result) {
    return (
      <Empty
        style={{ marginTop: 80 }}
        description="选择维度与指标后点击「查数」"
      />
    );
  }

  return (
    <div>
      <Space style={{ marginBottom: 12 }} wrap>
        <Typography.Text type="secondary">
          共 {result.row_count} 行 · 耗时 {result.elapsed_ms} ms
        </Typography.Text>
        {result.truncated && <Tag color="warning">结果已截断至上限</Tag>}
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
                    style={{ width: 140 }}
                    placeholder="X 轴（维度）"
                    value={effectiveX || undefined}
                    onChange={setXField}
                    options={dims.map((d) => ({ value: d, label: labelMap[d] ? `${labelMap[d]}（${d}）` : d }))}
                  />
                  <Select
                    style={{ width: 140 }}
                    placeholder="Y 轴（指标）"
                    value={effectiveY || undefined}
                    onChange={setYField}
                    options={metrics.map((m) => ({ value: m, label: labelMap[m] ? `${labelMap[m]}（${m}）` : m }))}
                  />
                  <Select
                    style={{ width: 100 }}
                    value={chartType}
                    onChange={setChartType}
                    options={[
                      { value: 'line', label: '折线图' },
                      { value: 'column', label: '柱状图' },
                    ]}
                  />
                </Space>
                {effectiveX && effectiveY ? (
                  <Suspense fallback={<Skeleton active paragraph={{ rows: 8 }} />}>
                    <ChartView
                      data={chartData}
                      xField={effectiveX}
                      yField={effectiveY}
                      type={chartType}
                    />
                  </Suspense>
                ) : (
                  <Empty description="图表需要至少一个维度和一个指标" />
                )}
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}
