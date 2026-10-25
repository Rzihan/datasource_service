import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Input, Skeleton, Space, Table, Tabs, Tag, Tooltip, Typography } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import type { StringMap } from '../types';

const MonacoEditor = lazy(() => import('./MonacoEditor'));

interface Props {
  value: StringMap;
  onChange: (value: StringMap) => void;
  placeholderKey?: string;
  placeholderValue?: string;
  // 全局字段名称字典。只有 label_map 会传：传了就多一列「来源」，
  // 并把继承来的中文名填进输入框的 placeholder，让人看清哪条是覆盖、哪条是继承。
  inherited?: StringMap;
}

type Row = { id: number; key: string; value: string };

let seq = 0;

function toRows(map: StringMap): Row[] {
  return Object.entries(map ?? {}).map(([k, v]) => ({ id: ++seq, key: k, value: v }));
}

function toMap(rows: Row[]): StringMap {
  const out: StringMap = {};
  for (const r of rows) {
    if (r.key.trim() !== '') {
      out[r.key] = r.value;
    }
  }
  return out;
}

// dim_map / mtx_map 就是 map[string]string，结构极简，
// 因此做成「表格 / JSON」双模式：不会写 JSON 的人用表格，想批量粘贴的人切 JSON。
export default function StringMapEditor({ value, onChange, placeholderKey, placeholderValue, inherited }: Props) {
  const [rows, setRows] = useState<Row[]>(() => toRows(value));
  const [mode, setMode] = useState<'table' | 'json'>('table');
  const [jsonText, setJsonText] = useState(() => JSON.stringify(value ?? {}, null, 2));
  const [jsonError, setJsonError] = useState<string>('');

  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  const serialized = JSON.stringify(value ?? {});

  // 只在「外部传入的值」与「内部派生的值」不一致时才重建表格，
  // 否则每次输入都会重建行，导致输入框失焦。
  useEffect(() => {
    const inner = JSON.stringify(toMap(rowsRef.current));
    if (inner !== serialized) {
      const parsed = JSON.parse(serialized) as StringMap;
      setRows(toRows(parsed));
      setJsonText(JSON.stringify(parsed, null, 2));
      setJsonError('');
    }
  }, [serialized]);

  const duplicateKeys = useMemo(() => {
    const seen = new Set<string>();
    const dup = new Set<string>();
    for (const r of rows) {
      const k = r.key.trim();
      if (!k) continue;
      if (seen.has(k)) dup.add(k);
      seen.add(k);
    }
    return [...dup];
  }, [rows]);

  const updateRow = (id: number, patch: Partial<Row>) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };

  const commitRows = (next: Row[]) => {
    setRows(next);
    onChange(toMap(next));
  };

  const onJsonChange = (text: string) => {
    setJsonText(text);
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setJsonError('必须是 JSON 对象，例如 {"cost": "sum(stat_cost)"}');
        return;
      }
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v !== 'string') {
          setJsonError(`字段 "${k}" 的值必须是字符串`);
          return;
        }
      }
      setJsonError('');
      onChange(parsed as StringMap);
    } catch (e) {
      setJsonError((e as Error).message);
    }
  };

  const columns: ColumnsType<Row> = [
    {
      title: '键',
      dataIndex: 'key',
      width: '38%',
      render: (_: unknown, row: Row) => (
        <Input
          value={row.key}
          placeholder={placeholderKey ?? '例如 cost'}
          status={row.key.trim() === '' || duplicateKeys.includes(row.key.trim()) ? 'error' : undefined}
          onChange={(e) => updateRow(row.id, { key: e.target.value })}
          onBlur={() => onChange(toMap(rowsRef.current))}
        />
      ),
    },
    {
      title: '值',
      dataIndex: 'value',
      render: (_: unknown, row: Row) => (
        <Input
          value={row.value}
          placeholder={
            inherited?.[row.key.trim()]
              ? `继承：${inherited[row.key.trim()]}` // 留空即继承全局，这里直接把继承值显示出来
              : (placeholderValue ?? '例如 sum(stat_cost)')
          }
          onChange={(e) => updateRow(row.id, { value: e.target.value })}
          onBlur={() => onChange(toMap(rowsRef.current))}
        />
      ),
    },
    // 来源列只在编辑 label_map 时出现：把「覆盖 / 继承 / 与全局一致」说清楚，
    // 否则同名不同义的字段改了全局字典后会静默变错，没人能发现。
    ...(inherited
      ? [
          {
            title: '来源',
            width: 130,
            render: (_: unknown, row: Row) => {
              const k = row.key.trim();
              if (!k) return null;
              const global = inherited[k];
              if (!global) {
                return row.value ? <Tag color="green">自定义</Tag> : null;
              }
              if (row.value === '') {
                return (
                  <Tooltip title="留空表示本数据集不使用中文名，即使全局有定义也不继承">
                    <Tag color="orange">不继承</Tag>
                  </Tooltip>
                );
              }
              if (row.value === global) {
                return <Tag color="blue">与全局一致</Tag>;
              }
              return (
                <Tooltip title={`全局定义为「${global}」，此处被覆盖为「${row.value}」`}>
                  <Tag color="purple">覆盖全局</Tag>
                </Tooltip>
              );
            },
          },
        ]
      : []),
    {
      title: '',
      width: 56,
      render: (_: unknown, row: Row) => (
        <Button
          type="text"
          danger
          icon={<DeleteOutlined />}
          onClick={() => commitRows(rowsRef.current.filter((r) => r.id !== row.id))}
        />
      ),
    },
  ];

  return (
    <div>
      <Tabs
        size="small"
        activeKey={mode}
        onChange={(k) => setMode(k as 'table' | 'json')}
        items={[
          { key: 'table', label: '表格模式' },
          { key: 'json', label: 'JSON 源码' },
        ]}
      />
      {mode === 'table' ? (
        <div>
          <Table
            size="small"
            rowKey="id"
            pagination={false}
            dataSource={rows}
            columns={columns}
            locale={{ emptyText: '暂无条目' }}
          />
          <Button
            type="dashed"
            block
            icon={<PlusOutlined />}
            style={{ marginTop: 8 }}
            onClick={() => commitRows([...rowsRef.current, { id: ++seq, key: '', value: '' }])}
          >
            添加一行
          </Button>
          {duplicateKeys.length > 0 && (
            <Alert
              type="warning"
              showIcon
              style={{ marginTop: 8 }}
              message={`存在重复键，保存后只会保留最后一个：${duplicateKeys.join('、')}`}
            />
          )}
          {rows.some((r) => r.key.trim() === '') && (
            <Alert type="warning" showIcon style={{ marginTop: 8 }} message="存在空键，保存时会被忽略" />
          )}
        </div>
      ) : (
        <div>
          <div style={{ border: '1px solid #d9d9d9', borderRadius: 8, overflow: 'hidden' }}>
            <Suspense fallback={<Skeleton active paragraph={{ rows: 5 }} style={{ padding: 12, height: 240 }} />}>
              <MonacoEditor language="json" value={jsonText} onChange={onJsonChange} height={240} />
            </Suspense>
          </div>
          {jsonError ? (
            <Alert type="error" showIcon style={{ marginTop: 8 }} message={`JSON 解析失败：${jsonError}`} />
          ) : (
            <Space style={{ marginTop: 8 }}>
              <Typography.Text type="secondary">
                共 {Object.keys(value ?? {}).length} 个条目
              </Typography.Text>
            </Space>
          )}
        </div>
      )}
    </div>
  );
}
