import { App, Alert, Button, InputNumber, Select, Space, Typography } from 'antd';
import { ClearOutlined, SearchOutlined } from '@ant-design/icons';
import type { FilterNode, OrderBy, QueryDataset } from '../types';
import FilterTreeEditor from './FilterTreeEditor';
import { countLeaves, emptyRoot, removeFields } from '../utils/filterTree';

interface Props {
  datasets: QueryDataset[];
  selected: QueryDataset | null;
  onSelectDataset: (key: string) => void;
  dims: string[];
  metrics: string[];
  onDimsChange: (dims: string[]) => void;
  onMetricsChange: (metrics: string[]) => void;
  filterTree: FilterNode;
  onFilterTreeChange: (tree: FilterNode) => void;
  orderBy: OrderBy | null;
  onOrderByChange: (order: OrderBy | null) => void;
  limit: number;
  onLimitChange: (limit: number) => void;
  dimValues: Record<string, string[]>;
  dimValueLoading: Record<string, boolean>;
  onRequestDimValues: (field: string) => void;
  onExecute: () => void;
  loading: boolean;
}

export default function QueryBuilder(props: Props) {
  const {
    datasets, selected, onSelectDataset,
    dims, metrics, onDimsChange, onMetricsChange,
    filterTree, onFilterTreeChange,
    orderBy, onOrderByChange,
    limit, onLimitChange,
    dimValues, dimValueLoading, onRequestDimValues,
    onExecute, loading,
  } = props;
  const { modal } = App.useApp();

  // 有中文含义就显示「中文（key）」，没有就退回 key
  const labelMap = selected?.label_map ?? {};
  const optionLabel = (k: string) => (labelMap[k] ? `${labelMap[k]}（${k}）` : k);

  const dimOptions = Object.keys(selected?.dim_map ?? {}).sort();
  const mtxOptions = Object.keys(selected?.mtx_map ?? {}).sort();
  const sortableOptions = [...dims, ...metrics];

  // 只有已勾选的指标才能用来过滤：没勾选的指标不会出现在结果里，
  // 拿它做过滤条件用户看不到依据，语义上也说不通。
  const filterableMetrics = mtxOptions.filter((k) => metrics.includes(k));

  // 取消勾选指标时，挂在该指标上的过滤条件必须一起清掉，否则会提交一个
  // 用户看不懂的查询。清除前先弹确认，说明要动哪些东西。
  const handleMetricsChange = (next: string[]) => {
    const removed = metrics.filter((m) => !next.includes(m));
    const collected: string[] = [];
    const nextTree = removeFields(filterTree, removed, collected);
    const affectedSort = orderBy && removed.includes(orderBy.field) ? orderBy.field : '';
    if (collected.length === 0 && !affectedSort) {
      onMetricsChange(next);
      return;
    }

    const parts: string[] = [];
    if (collected.length > 0) {
      const names = [...new Set(collected)].map((m) => `「${optionLabel(m)}」`).join('、');
      parts.push(`指标 ${names} 上的 ${collected.length} 个过滤条件会被清除`);
    }
    if (affectedSort) {
      parts.push(`排序字段「${optionLabel(affectedSort)}」已失效，会被清空`);
    }

    modal.confirm({
      title: '取消勾选指标',
      content: `${parts.join('；')}。是否继续？`,
      okText: '继续',
      cancelText: '放弃',
      onOk: () => {
        onMetricsChange(next);
        if (collected.length > 0) {
          onFilterTreeChange(nextTree ?? emptyRoot());
        }
        if (affectedSort) onOrderByChange(null);
      },
    });
  };

  const leafCount = countLeaves(filterTree);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          数据集
        </Typography.Text>
        <Select
          style={{ width: '100%', marginTop: 4 }}
          placeholder="选择数据集"
          value={selected?.dataset_key}
          onChange={onSelectDataset}
          options={datasets.map((d) => ({
            value: d.dataset_key,
            label: `${d.dataset_key} · ${d.dataset_name}`,
          }))}
        />
      </div>

      <div>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          维度
        </Typography.Text>
        <Select
          mode="multiple"
          style={{ width: '100%', marginTop: 4 }}
          placeholder={selected ? '选择维度' : '请先选择数据集'}
          disabled={!selected}
          value={dims}
          onChange={onDimsChange}
          options={dimOptions.map((k) => ({ value: k, label: optionLabel(k) }))}
        />
      </div>

      <div>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          指标
        </Typography.Text>
        <Select
          mode="multiple"
          style={{ width: '100%', marginTop: 4 }}
          placeholder={selected ? '选择指标' : '请先选择数据集'}
          disabled={!selected}
          value={metrics}
          onChange={handleMetricsChange}
          options={mtxOptions.map((k) => ({ value: k, label: optionLabel(k) }))}
        />
      </div>

      <div>
        <Space style={{ width: '100%', justifyContent: 'space-between' }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            过滤条件{leafCount > 0 ? `（${leafCount} 个）` : ''}
          </Typography.Text>
          {leafCount > 0 && (
            <Button
              type="link"
              size="small"
              icon={<ClearOutlined />}
              onClick={() => onFilterTreeChange(emptyRoot())}
            >
              清空
            </Button>
          )}
        </Space>
        <div style={{ marginTop: 4 }}>
          <FilterTreeEditor
            node={filterTree}
            onChange={onFilterTreeChange}
            depth={1}
            dimOptions={dimOptions}
            metricOptions={filterableMetrics}
            isMetricField={(field) => mtxOptions.includes(field)}
            optionLabel={optionLabel}
            dimValues={dimValues}
            dimValueLoading={dimValueLoading}
            onRequestDimValues={onRequestDimValues}
          />
        </div>
      </div>

      <div>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          排序
        </Typography.Text>
        <Space.Compact style={{ width: '100%', marginTop: 4 }}>
          <Select
            style={{ width: '60%' }}
            allowClear
            placeholder="字段（维度或指标）"
            value={orderBy?.field}
            options={sortableOptions.map((k) => ({ value: k, label: optionLabel(k) }))}
            onChange={(v) => onOrderByChange(v ? { field: v, desc: orderBy?.desc ?? true } : null)}
          />
          <Select
            style={{ width: '40%' }}
            value={orderBy?.desc ? 'desc' : 'asc'}
            onChange={(v) => orderBy && onOrderByChange({ ...orderBy, desc: v === 'desc' })}
            options={[
              { value: 'desc', label: '降序' },
              { value: 'asc', label: '升序' },
            ]}
          />
        </Space.Compact>
      </div>

      <div>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          返回行数（上限 10000）
        </Typography.Text>
        <InputNumber
          style={{ width: '100%', marginTop: 4 }}
          min={1}
          max={10000}
          value={limit}
          onChange={(v) => onLimitChange(v ?? 1000)}
        />
      </div>

      {!selected && <Alert type="info" showIcon message="先选择一个数据集" />}

      <Button
        type="primary"
        icon={<SearchOutlined />}
        loading={loading}
        disabled={!selected || (dims.length === 0 && metrics.length === 0)}
        onClick={onExecute}
      >
        查数
      </Button>
    </div>
  );
}
