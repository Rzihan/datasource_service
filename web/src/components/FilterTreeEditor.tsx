import {
  Button,
  Input,
  Segmented,
  Select,
  Space,
  Tooltip,
  Typography,
} from 'antd';
import { DeleteOutlined, PlusOutlined, PartitionOutlined } from '@ant-design/icons';
import type { FilterNode } from '../types';
import { isGroup } from '../utils/filterTree';

const OPS = ['=', '!=', '>', '>=', '<', '<=', 'like', 'in', 'not in'];
// 指标是聚合出来的数值，模糊匹配没有语义，后端也会直接拒绝
const METRIC_OPS = ['=', '!=', '>', '>=', '<', '<=', 'in', 'not in'];
const MULTI_VALUE_OPS = ['in', 'not in'];

// 与后端 MaxFilterDepth 保持一致
export const MAX_DEPTH = 5;

interface Props {
  node: FilterNode;
  onChange: (next: FilterNode) => void;
  onRemove?: () => void;
  depth: number;
  dimOptions: string[];
  metricOptions: string[];
  isMetricField: (field: string) => boolean;
  optionLabel: (k: string) => string;
  dimValues: Record<string, string[]>;
  dimValueLoading: Record<string, boolean>;
  onRequestDimValues: (field: string) => void;
}

// 递归的条件组编辑器：每个分组自带 AND / OR 切换，
// 子分组可以继续嵌套，用来表达 A AND (B OR C) 这类组合。
export default function FilterTreeEditor(props: Props) {
  const {
    node, onChange, onRemove, depth,
    dimOptions, metricOptions, isMetricField, optionLabel,
    dimValues, dimValueLoading, onRequestDimValues,
  } = props;

  const children = node.children ?? [];
  const canAddGroup = depth < MAX_DEPTH;
  const hasField = dimOptions.length > 0 || metricOptions.length > 0;

  const updateChild = (index: number, next: FilterNode) => {
    onChange({ ...node, children: children.map((c, i) => (i === index ? next : c)) });
  };
  const removeChild = (index: number) => {
    onChange({ ...node, children: children.filter((_, i) => i !== index) });
  };

  const defaultField = () => dimOptions[0] ?? metricOptions[0] ?? '';
  const defaultLeaf = (field: string): FilterNode => ({
    field,
    op: isMetricField(field) ? '>' : '=',
    value: '',
  });

  const addCondition = () => {
    const field = defaultField();
    onChange({ ...node, children: [...children, defaultLeaf(field)] });
    if (field && !isMetricField(field)) onRequestDimValues(field);
  };

  const addGroup = () => {
    const field = defaultField();
    // 子分组默认取反的连接词，这样一点就能搭出 AND (… OR …) 这种常见形状
    const logic: 'and' | 'or' = node.logic === 'and' ? 'or' : 'and';
    onChange({
      ...node,
      children: [...children, { logic, children: [defaultLeaf(field)] }],
    });
    if (field && !isMetricField(field)) onRequestDimValues(field);
  };

  // 字段下拉按维度 / 指标分组：指标只列已勾选的，未勾选的不能用于过滤
  const fieldOptions = [
    { label: '维度（行级过滤）', options: dimOptions.map((k) => ({ value: k, label: optionLabel(k) })) },
    { label: '指标（聚合后过滤）', options: metricOptions.map((k) => ({ value: k, label: optionLabel(k) })) },
  ].filter((g) => g.options.length > 0);

  const renderLeaf = (leaf: FilterNode, index: number) => {
    const op = leaf.op ?? '=';
    const multi = MULTI_VALUE_OPS.includes(op);
    const field = leaf.field ?? '';
    const metric = isMetricField(field);
    const ops = metric ? METRIC_OPS : OPS;
    const values = dimValues[field] ?? [];
    const patch = (p: Partial<FilterNode>) => updateChild(index, { ...leaf, ...p });

    return (
      <Space.Compact key={index} style={{ width: '100%' }}>
        <Select
          style={{ width: '30%' }}
          value={field}
          options={fieldOptions}
          onChange={(v) => {
            const toMetric = isMetricField(v);
            patch({
              field: v,
              // 从维度切到指标时，若当前是 like 则要换掉，否则后端会拒绝
              op: toMetric && !METRIC_OPS.includes(op) ? '>' : op,
              value: '',
              values: [],
            });
            if (!toMetric) onRequestDimValues(v);
          }}
        />
        <Select
          style={{ width: '20%' }}
          value={op}
          options={ops.map((o) => ({ value: o, label: o }))}
          onChange={(v) => {
            const isMulti = v === 'in' || v === 'not in';
            patch({ op: v, value: isMulti ? '' : leaf.value, values: isMulti ? leaf.values ?? [] : [] });
          }}
        />
        {multi ? (
          <Select
            mode={metric ? 'tags' : 'multiple'}
            style={{ width: '38%' }}
            placeholder={metric ? '输入数值后回车' : '选择值'}
            tokenSeparators={metric ? [','] : undefined}
            loading={!metric && dimValueLoading[field]}
            value={leaf.values ?? []}
            onChange={(v) => patch({ values: v })}
            options={values.map((v) => ({ value: v, label: v }))}
          />
        ) : values.length > 0 && !metric ? (
          <Select
            showSearch
            style={{ width: '38%' }}
            placeholder="选择或输入值"
            loading={dimValueLoading[field]}
            value={leaf.value || undefined}
            onChange={(v) => patch({ value: v })}
            options={values.map((v) => ({ value: v, label: v }))}
          />
        ) : (
          <Input
            style={{ width: '38%' }}
            placeholder={metric ? '数值' : '值'}
            value={leaf.value ?? ''}
            onChange={(e) => patch({ value: e.target.value })}
          />
        )}
        <Button icon={<DeleteOutlined />} onClick={() => removeChild(index)} />
      </Space.Compact>
    );
  };

  return (
    <div
      style={{
        border: '1px dashed #d9d9d9',
        borderRadius: 6,
        padding: 8,
        background: depth % 2 === 1 ? '#fafafa' : '#ffffff',
      }}
    >
      <Space style={{ width: '100%', justifyContent: 'space-between' }}>
        <Space size={6}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {children.length > 1 ? '满足' : '条件'}
          </Typography.Text>
          <Segmented
            size="small"
            value={node.logic ?? 'and'}
            onChange={(v) => onChange({ ...node, logic: v as 'and' | 'or' })}
            options={[
              { label: '全部 AND', value: 'and' },
              { label: '任一 OR', value: 'or' },
            ]}
          />
        </Space>
        {onRemove && (
          <Button size="small" type="text" icon={<DeleteOutlined />} onClick={onRemove} />
        )}
      </Space>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
        {children.map((child, i) =>
          isGroup(child) ? (
            <FilterTreeEditor
              key={i}
              node={child}
              onChange={(next) => updateChild(i, next)}
              onRemove={() => removeChild(i)}
              depth={depth + 1}
              dimOptions={dimOptions}
              metricOptions={metricOptions}
              isMetricField={isMetricField}
              optionLabel={optionLabel}
              dimValues={dimValues}
              dimValueLoading={dimValueLoading}
              onRequestDimValues={onRequestDimValues}
            />
          ) : (
            renderLeaf(child, i)
          ),
        )}
        {children.length === 0 && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            暂无条件，点击下面的按钮添加
          </Typography.Text>
        )}
      </div>

      <Space size={8} style={{ marginTop: 8 }}>
        <Button
          size="small"
          icon={<PlusOutlined />}
          disabled={!hasField}
          onClick={addCondition}
        >
          条件
        </Button>
        {canAddGroup ? (
          <Button
            size="small"
            icon={<PartitionOutlined />}
            disabled={!hasField}
            onClick={addGroup}
          >
            分组
          </Button>
        ) : (
          <Tooltip title={`最多嵌套 ${MAX_DEPTH} 层`}>
            <Button size="small" icon={<PartitionOutlined />} disabled>
              分组
            </Button>
          </Tooltip>
        )}
      </Space>
    </div>
  );
}
