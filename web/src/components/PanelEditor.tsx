import { useEffect, useMemo, useState } from 'react';
import { Button, Drawer, Form, Input, InputNumber, Select, Space, Switch, Typography } from 'antd';
import type { DashboardPanel, PanelView, QueryDataset } from '../types';
import { panelQuery, parseIntent } from '../utils/intent';

// 面板编辑器。
//
// 刻意不嵌整块查询构建器：面板的编辑发生在「我已经知道要什么」的前提下，
// 要改的是维度/指标/排序这几件事，不是再来一遍探索。真要探索，
// 去查询页调好再「加入大盘」，那条路更顺。
interface Props {
  open: boolean;
  panel: DashboardPanel | null;
  datasets: QueryDataset[];
  onClose: () => void;
  onSubmit: (panel: DashboardPanel) => void;
}

const VIEW_OPTIONS: Array<{ value: PanelView; label: string }> = [
  { value: 'metric', label: '指标卡（一个数）' },
  { value: 'line', label: '折线图（看趋势）' },
  { value: 'column', label: '柱状图（比大小）' },
  { value: 'pie', label: '饼图（看占比）' },
  { value: 'table', label: '明细表' },
];

const SPAN_OPTIONS = [3, 4, 6, 8, 12];

export default function PanelEditor({ open, panel, datasets, onClose, onSubmit }: Props) {
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [dataset, setDataset] = useState('');
  const [view, setView] = useState<PanelView>('table');
  const [span, setSpan] = useState(6);
  const [height, setHeight] = useState(280);
  const [dims, setDims] = useState<string[]>([]);
  const [metrics, setMetrics] = useState<string[]>([]);
  const [order, setOrder] = useState('');
  const [desc, setDesc] = useState(true);
  const [limit, setLimit] = useState(200);
  const [follow, setFollow] = useState(true);
  const [emitFilter, setEmitFilter] = useState('');

  const ds = datasets.find((d) => d.dataset_key === dataset);

  // 每打开一次就按当前面板重置一次。不做「编辑中状态跨面板保留」——
  // 那样在点开另一个面板时会带上一堆上一个面板的条件。
  useEffect(() => {
    if (!open || !panel) return;
    setTitle(panel.title ?? '');
    setNote(panel.note ?? '');
    setDataset(panel.dataset);
    setView(panel.view);
    setSpan(panel.span || 6);
    setHeight(panel.height || 280);
    setFollow(panel.follow !== false);
    setEmitFilter(panel.emit_filter ?? '');
    const d = datasets.find((x) => x.dataset_key === panel.dataset);
    if (d) {
      const it = parseIntent(d, panelQuery(d, panel.query));
      setDims(it.dims);
      setMetrics(it.metrics);
      setOrder(it.orderBy?.field ?? '');
      setDesc(it.orderBy?.desc ?? true);
      setLimit(it.limit || 200);
    }
  }, [open, panel, datasets]);

  const dimOptions = useMemo(
    () =>
      Object.keys({ ...(ds?.dim_map ?? {}), ...(ds?.multi_dim_map ?? {}) }).map((f) => ({
        value: f,
        label: ds?.label_map?.[f] ? `${ds.label_map[f]}（${f}）` : f,
      })),
    [ds],
  );
  const metricOptions = useMemo(
    () =>
      Object.keys(ds?.mtx_map ?? {}).map((f) => ({
        value: f,
        label: ds?.label_map?.[f] ? `${ds.label_map[f]}（${f}）` : f,
      })),
    [ds],
  );

  const submit = () => {
    if (!panel) return;
    const sp = new URLSearchParams();
    if (dims.length > 0) sp.set('dims', dims.join(','));
    if (metrics.length > 0) sp.set('metrics', metrics.join(','));
    if (order) {
      sp.set('order', order);
      sp.set('dir', desc ? 'desc' : 'asc');
    }
    sp.set('limit', String(limit));
    onSubmit({
      ...panel,
      title: title.trim(),
      note: note.trim(),
      dataset,
      view,
      span,
      height,
      query: sp.toString(),
      follow: follow ? undefined : false,
      emit_filter: emitFilter || undefined,
      metric: metrics[0],
    });
  };

  return (
    <Drawer
      title="编辑面板"
      width={420}
      open={open && !!panel}
      onClose={onClose}
      destroyOnClose={false}
      extra={
        <Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            改动要點「保存」才生效
          </Typography.Text>
        </Space>
      }
      footer={
        <Space style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" onClick={submit}>
            确定
          </Button>
        </Space>
      }
    >
      <Form layout="vertical" size="small">
        <Form.Item label="标题">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="不填就用指标名" />
        </Form.Item>
        <Form.Item label="这一块在说什么（口径 / 提醒）">
          <Input.TextArea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="比如：比率不可加，这里显示的是行均值"
          />
        </Form.Item>
        <Form.Item label="数据集">
          <Select
            value={dataset}
            onChange={(v) => {
              setDataset(v);
              setDims([]);
              setMetrics([]);
              setOrder('');
            }}
            options={datasets.map((d) => ({ value: d.dataset_key, label: `${d.dataset_key} · ${d.dataset_name}` }))}
          />
        </Form.Item>
        <Form.Item label="维度">
          <Select
            mode="multiple"
            value={dims}
            onChange={setDims}
            options={dimOptions}
            placeholder="不填就是「总计一行」"
          />
        </Form.Item>
        <Form.Item label="指标">
          <Select mode="multiple" value={metrics} onChange={setMetrics} options={metricOptions} />
        </Form.Item>
        <Form.Item label="画成什么">
          <Select value={view} onChange={setView} options={VIEW_OPTIONS} />
        </Form.Item>
        <Form.Item label="占多宽（12 栅格）">
          <Select value={span} onChange={setSpan} options={SPAN_OPTIONS.map((s) => ({ value: s, label: `${s} / 12` }))} />
        </Form.Item>
        <Form.Item label="高度（px）">
          <InputNumber value={height} min={140} max={800} step={20} onChange={(v) => setHeight(Number(v) || 280)} />
        </Form.Item>
        <Form.Item label="排序字段">
          <Select
            allowClear
            value={order || undefined}
            onChange={(v) => setOrder(v ?? '')}
            options={[...dimOptions, ...metricOptions]}
          />
        </Form.Item>
        <Form.Item label={order ? '降序 / 升序' : '降序 / 升序（先选排序字段）'}>
          <Select
            value={desc}
            disabled={!order}
            onChange={setDesc}
            options={[
              { value: true, label: '降序' },
              { value: false, label: '升序' },
            ]}
          />
        </Form.Item>
        <Form.Item label="取多少行">
          <InputNumber value={limit} min={1} max={10000} onChange={(v) => setLimit(Number(v) || 200)} />
        </Form.Item>
        <Form.Item label="跟随整屏筛选">
          <Switch checked={follow} onChange={setFollow} />
          <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
            关掉后这一块不随顶部筛选变化（适合「横向对比」类面板）
          </Typography.Text>
        </Form.Item>
        <Form.Item label="点图形时按哪个字段下钻">
          <Select
            allowClear
            value={emitFilter || undefined}
            onChange={(v) => setEmitFilter(v ?? '')}
            options={dimOptions}
            placeholder="不填就用第一个维度"
          />
        </Form.Item>
      </Form>
    </Drawer>
  );
}
