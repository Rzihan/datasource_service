import { Alert, Button, Input, InputNumber, Select, Space, Typography } from 'antd';
import { DeleteOutlined, PlusOutlined, SearchOutlined } from '@ant-design/icons';
import type { DatasourceConfig, Filter, OrderBy } from '../types';

interface Props {
  datasources: DatasourceConfig[];
  selected: DatasourceConfig | null;
  onSelectDatasource: (key: string) => void;
  dims: string[];
  metrics: string[];
  onDimsChange: (dims: string[]) => void;
  onMetricsChange: (metrics: string[]) => void;
  filters: Filter[];
  onFiltersChange: (filters: Filter[]) => void;
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

const OPS = ['=', '!=', '>', '>=', '<', '<=', 'like', 'in', 'not in'];
const MULTI_VALUE_OPS = ['in', 'not in'];

export default function QueryBuilder(props: Props) {
  const {
    datasources, selected, onSelectDatasource,
    dims, metrics, onDimsChange, onMetricsChange,
    filters, onFiltersChange,
    orderBy, onOrderByChange,
    limit, onLimitChange,
    dimValues, dimValueLoading, onRequestDimValues,
    onExecute, loading,
  } = props;

  // 有中文含义就显示「中文（key）」，没有就退回 key
  const labelMap = selected?.label_map ?? {};
  const optionLabel = (k: string) => (labelMap[k] ? `${labelMap[k]}（${k}）` : k);

  const dimOptions = Object.keys(selected?.dim_map ?? {}).sort();
  const mtxOptions = Object.keys(selected?.mtx_map ?? {}).sort();
  const sortableOptions = [...dims, ...metrics];

  const updateFilter = (index: number, patch: Partial<Filter>) => {
    const next = filters.map((f, i) => (i === index ? { ...f, ...patch } : f));
    onFiltersChange(next);
  };

  const addFilter = () => {
    const field = dimOptions[0] ?? '';
    const next = [...filters, { field, op: '=', value: '' }];
    onFiltersChange(next);
    if (field) onRequestDimValues(field);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          数据源
        </Typography.Text>
        <Select
          style={{ width: '100%', marginTop: 4 }}
          placeholder="选择数据源"
          value={selected?.datasource_key}
          onChange={onSelectDatasource}
          options={datasources.map((d) => ({
            value: d.datasource_key,
            label: `${d.datasource_key} · ${d.datasource_name}`,
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
          placeholder={selected ? '选择维度' : '请先选择数据源'}
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
          placeholder={selected ? '选择指标' : '请先选择数据源'}
          disabled={!selected}
          value={metrics}
          onChange={onMetricsChange}
          options={mtxOptions.map((k) => ({ value: k, label: optionLabel(k) }))}
        />
      </div>

      <div>
        <Space style={{ width: '100%', justifyContent: 'space-between' }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            过滤条件
          </Typography.Text>
          <Button
            type="link"
            size="small"
            icon={<PlusOutlined />}
            disabled={!selected || dimOptions.length === 0}
            onClick={addFilter}
          >
            添加
          </Button>
        </Space>
        {filters.length === 0 && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            无
          </Typography.Text>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
          {filters.map((f, i) => {
            const multi = MULTI_VALUE_OPS.includes(f.op);
            const values = dimValues[f.field] ?? [];
            return (
              <Space.Compact key={i} style={{ width: '100%' }}>
                <Select
                  style={{ width: '32%' }}
                  value={f.field}
                  options={dimOptions.map((k) => ({ value: k, label: optionLabel(k) }))}
                  onChange={(v) => {
                    updateFilter(i, { field: v, value: '', values: [] });
                    onRequestDimValues(v);
                  }}
                />
                <Select
                  style={{ width: '22%' }}
                  value={f.op}
                  options={OPS.map((o) => ({ value: o, label: o }))}
                  onChange={(v) =>
                    updateFilter(i, { op: v, value: multi ? '' : f.value, values: multi ? f.values ?? [] : [] })
                  }
                />
                {multi ? (
                  <Select
                    mode="multiple"
                    style={{ width: '38%' }}
                    placeholder="选择值"
                    loading={dimValueLoading[f.field]}
                    value={f.values ?? []}
                    onChange={(v) => updateFilter(i, { values: v })}
                    options={values.map((v) => ({ value: v, label: v }))}
                  />
                ) : values.length > 0 ? (
                  <Select
                    showSearch
                    style={{ width: '38%' }}
                    placeholder="选择或输入值"
                    loading={dimValueLoading[f.field]}
                    value={f.value || undefined}
                    onChange={(v) => updateFilter(i, { value: v })}
                    options={values.map((v) => ({ value: v, label: v }))}
                  />
                ) : (
                  <Input
                    style={{ width: '38%' }}
                    placeholder="值"
                    value={f.value}
                    onChange={(e) => updateFilter(i, { value: e.target.value })}
                  />
                )}
                <Button
                  icon={<DeleteOutlined />}
                  onClick={() => onFiltersChange(filters.filter((_, idx) => idx !== i))}
                />
              </Space.Compact>
            );
          })}
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

      {!selected && <Alert type="info" showIcon message="先选择一个数据源" />}

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
