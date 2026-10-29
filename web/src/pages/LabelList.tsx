import { useCallback, useEffect, useMemo, useState } from 'react';
import { App, Button, Input, Popconfirm, Space, Table, Tabs, Tag, Tooltip, Typography } from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { deleteLabel, fetchLabelList, fetchList } from '../api';
import LabelCheckPanel from '../components/LabelCheckPanel';
import LabelDrawer from '../components/LabelDrawer';
import type { GlobalLabel } from '../types';

// 一次最多拉这么多数据集来统计引用面。字典页不是数据集页，
// 这里只需要一个「有多少个数据集在用这个字段」的量级，不需要精确到全量。
const REF_SCAN_SIZE = 200;

export default function LabelList() {
  const { message } = App.useApp();
  const [items, setItems] = useState<GlobalLabel[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(20);
  const [keyword, setKeyword] = useState('');
  const [loading, setLoading] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<GlobalLabel | null>(null);
  const [tab, setTab] = useState('list');
  // 字段名 → 引用它的数据集列表，用来在删除/改名时提示影响面
  const [refs, setRefs] = useState<Record<string, string[]>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchLabelList({ page, size, keyword: keyword || undefined });
      setItems(res.items ?? []);
      setTotal(res.total);
    } catch (e) {
      message.error((e as Error).message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, [page, size, keyword, message]);

  // 引用面单独扫一次数据集配置。失败不阻断页面：引用数只是辅助信息，
  // 为了显示「被 3 个数据集引用」而让整页打不开不值得。
  const loadRefs = useCallback(async () => {
    try {
      const res = await fetchList({ page: 1, size: REF_SCAN_SIZE });
      const acc: Record<string, string[]> = {};
      for (const ds of res.items ?? []) {
        for (const k of [...Object.keys(ds.dim_map ?? {}), ...Object.keys(ds.mtx_map ?? {})]) {
          (acc[k] ??= []).push(ds.dataset_key);
        }
      }
      setRefs(acc);
    } catch {
      setRefs({});
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadRefs();
  }, [loadRefs]);

  const onCreate = () => {
    setEditing(null);
    setDrawerOpen(true);
  };

  const onEdit = (record: GlobalLabel) => {
    setEditing(record);
    setDrawerOpen(true);
  };

  const onDelete = async (record: GlobalLabel) => {
    try {
      await deleteLabel(record.field_key);
      message.success(`已删除 ${record.field_key}`);
      void load();
    } catch (e) {
      message.error((e as Error).message || '删除失败');
    }
  };

  const columns: ColumnsType<GlobalLabel> = [
    {
      title: 'field_key',
      dataIndex: 'field_key',
      width: 200,
      render: (v: string) => <Typography.Text code copyable={{ text: v }}>{v}</Typography.Text>,
    },
    { title: '中文名', dataIndex: 'label', width: 160 },
    {
      title: '状态',
      dataIndex: 'status',
      width: 80,
      render: (v: number) =>
        v === 1 ? <Tag color="green">启用</Tag> : <Tag color="default">停用</Tag>,
    },
    {
      title: '引用数据集',
      dataIndex: 'field_key',
      width: 180,
      render: (v: string) => {
        const list = refs[v] ?? [];
        if (list.length === 0) {
          return <Typography.Text type="secondary">无数据集使用该字段</Typography.Text>;
        }
        return (
          <Tooltip title={list.join('、')}>
            <Tag color="blue">{list.length} 个</Tag>
          </Tooltip>
        );
      },
    },
    { title: '更新人', dataIndex: 'updated_by', width: 110 },
    {
      title: '更新时间',
      dataIndex: 'updated_at',
      width: 170,
      render: (v: string) => dayjs(v).format('YYYY-MM-DD HH:mm:ss'),
    },
    {
      title: '操作',
      width: 140,
      fixed: 'right',
      render: (_: unknown, record: GlobalLabel) => (
        <Space size="small">
          <Button type="link" size="small" onClick={() => onEdit(record)}>
            编辑
          </Button>
          <Popconfirm
            title={`确认删除 ${record.field_key}？`}
            description={
              (refs[record.field_key] ?? []).length > 0
                ? `有 ${(refs[record.field_key] ?? []).length} 个数据集在用这个字段，删除后它们会退回显示字段名本身`
                : '软删除，配置会从列表移除。'
            }
            okText="删除"
            cancelText="取消"
            onConfirm={() => onDelete(record)}
          >
            <Button type="link" size="small" danger>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const enabledCount = useMemo(() => items.filter((i) => i.status === 1).length, [items]);

  return (
    <div>
      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          {
            key: 'list',
            label: '字段定义',
            children: (
              <>
                <Space style={{ marginBottom: 16 }} wrap>
                  <Input.Search
                    allowClear
                    placeholder="按字段名或中文名搜索"
                    style={{ width: 280 }}
                    onSearch={(v) => {
                      setPage(1);
                      setKeyword(v.trim());
                    }}
                  />
                  <Button icon={<ReloadOutlined />} onClick={() => void load()}>
                    刷新
                  </Button>
                  <Button type="primary" icon={<PlusOutlined />} onClick={onCreate}>
                    新建字段名称
                  </Button>
                  <Typography.Text type="secondary">
                    全局字典对所有数据集生效；单个数据集可在自己的 label_map 中覆盖（本页{' '}
                    {enabledCount} 条启用）
                  </Typography.Text>
                </Space>

                <Table
                  rowKey="field_key"
                  loading={loading}
                  columns={columns}
                  dataSource={items}
                  scroll={{ x: 1000 }}
                  pagination={{
                    current: page,
                    pageSize: size,
                    total,
                    showSizeChanger: true,
                    showTotal: (t) => `共 ${t} 条`,
                    onChange: (p, s) => {
                      setPage(p);
                      setSize(s);
                    },
                  }}
                />
              </>
            ),
          },
          { key: 'check', label: '一致性检查', children: <LabelCheckPanel /> },
        ]}
      />

      <LabelDrawer
        open={drawerOpen}
        record={editing}
        onClose={() => setDrawerOpen(false)}
        onSaved={() => {
          setDrawerOpen(false);
          void load();
          void loadRefs();
        }}
      />
    </div>
  );
}
