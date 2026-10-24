import { App, Alert, Button, Input, InputNumber, Select, Space, Typography } from 'antd';
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
// 指标是聚合出来的数值，模糊匹配没有语义，后端也会直接拒绝
const METRIC_OPS = ['=', '!=', '>', '>=', '<', '<=', 'in', 'not in'];
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

  const updateFilter = (index: number, patch: Partial<Filter>) => {
    const next = filters.map((f, i) => (i === index ? { ...f, ...patch } : f));
    onFiltersChange(next);
  };

  // 过滤字段下拉：维度走 WHERE、指标走 HAVING，分组展示避免混淆
  const filterFieldOptions = [
    { label: '维度（行级过滤）', options: dimOptions.map((k) => ({ value: k, label: optionLabel(k) })) },
    { label: '指标（聚合后过滤）', options: filterableMetrics.map((k) => ({ value: k, label: optionLabel(k) })) },
  ].filter((g) => g.options.length > 0);

  const isMetricField = (field: string) => mtxOptions.includes(field);

  // 取消勾选指标时，挂在该指标上的过滤条件必须一起清掉，否则会提交一个
  // 用户看不懂的查询。清除前先弹确认，说明要动哪些东西。
  const handleMetricsChange = (next: string[]) => {
    const removed = metrics.filter((m) => !next.includes(m));
    const affectedFilters = filters.filter((f) => removed.includes(f.field));
    const affectedSort = orderBy && removed.includes(orderBy.field) ? orderBy.field : '';
    if (affectedFilters.length === 0 && !affectedSort) {
      onMetricsChange(next);
      return;
    }

    const parts: string[] = [];
    if (affectedFilters.length > 0) {
      const names = [...new Set(affectedFilters.map((f) => f.field))]
        .map((m) => `「${optionLabel(m)}」`)
        .join('、');
      parts.push(`指标 ${names} 上的 ${affectedFilters.length} 个过滤条件会被清除`);
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
        if (affectedFilters.length > 0) {
          onFiltersChange(filters.filter((f) => !removed.includes(f.field)));
        }
        if (affectedSort) onOrderByChange(null);
      },
    });
  };

  const addFilter = () => {
    const field = dimOptions[0] ?? filterableMetrics[0] ?? '';
    const next = [...filters, { field, op: isMetricField(field) ? '>' : '=', value: '' }];
    onFiltersChange(next);
    // 指标没有候选值（不查 distinct），只有维度才去拉
    if (field && !isMetricField(field)) onRequestDimValues(field);
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
          onChange={handleMetricsChange}
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
            disabled={!selected || (dimOptions.length === 0 && filterableMetrics.length === 0)}
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
            // 指标是聚合结果，后端会做数值比较：不给 like，且值只能手输
            const metric = isMetricField(f.field);
            const ops = metric ? METRIC_OPS : OPS;
            return (
              <Space.Compact key={i} style={{ width: '100%' }}>
                <Select
                  style={{ width: '32%' }}
                  value={f.field}
                  options={filterFieldOptions}
                  onChange={(v) => {
                    const toMetric = isMetricField(v);
                    updateFilter(i, {
                      field: v,
                      // 从维度切到指标时，若当前是 like 则要换掉，否则后端会拒绝
                      op: toMetric && !METRIC_OPS.includes(f.op) ? '>' : f.op,
                      value: '',
                      values: [],
                    });
                    if (!toMetric) onRequestDimValues(v);
                  }}
                />
                <Select
                  style={{ width: '22%' }}
                  value={f.op}
                  options={ops.map((o) => ({ value: o, label: o }))}
                  onChange={(v) =>
                    updateFilter(i, { op: v, value: multi ? '' : f.value, values: multi ? f.values ?? [] : [] })
                  }
                />
                {multi ? (
                  <Select
                    mode={metric ? 'tags' : 'multiple'}
                    style={{ width: '38%' }}
                    placeholder={metric ? '输入数值后回车' : '选择值'}
                    tokenSeparators={metric ? [','] : undefined}
                    loading={!metric && dimValueLoading[f.field]}
                    value={f.values ?? []}
                    onChange={(v) => updateFilter(i, { values: v })}
                    options={values.map((v) => ({ value: v, label: v }))}
                  />
                ) : values.length > 0 && !metric ? (
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
                    placeholder={metric ? '数值' : '值'}
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
