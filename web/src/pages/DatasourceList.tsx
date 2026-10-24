import { useCallback, useEffect, useState } from 'react';
import { App, Button, Input, Popconfirm, Space, Table, Tag, Tooltip, Typography } from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { deleteDatasource, fetchList } from '../api';
import EditDrawer from '../components/EditDrawer';
import type { DatasourceConfig } from '../types';

export default function DatasourceList() {
  const { message } = App.useApp();
  const [items, setItems] = useState<DatasourceConfig[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(20);
  const [keyword, setKeyword] = useState('');
  const [loading, setLoading] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<DatasourceConfig | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchList({ page, size, keyword: keyword || undefined });
      setItems(res.items ?? []);
      setTotal(res.total);
    } catch (e) {
      message.error((e as Error).message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, [page, size, keyword, message]);

  useEffect(() => {
    void load();
  }, [load]);

  const onCreate = () => {
    setEditing(null);
    setDrawerOpen(true);
  };

  const onEdit = (record: DatasourceConfig) => {
    setEditing(record);
    setDrawerOpen(true);
  };

  const onDelete = async (record: DatasourceConfig) => {
    try {
      await deleteDatasource(record.datasource_key);
      message.success(`已删除 ${record.datasource_key}`);
      void load();
    } catch (e) {
      message.error((e as Error).message || '删除失败');
    }
  };

  const columns: ColumnsType<DatasourceConfig> = [
    {
      title: 'datasource_key',
      dataIndex: 'datasource_key',
      width: 200,
      render: (v: string) => <Typography.Text code copyable={{ text: v }}>{v}</Typography.Text>,
    },
    { title: 'datasource_name', dataIndex: 'datasource_name', width: 180 },
    {
      title: '状态',
      dataIndex: 'status',
      width: 80,
      render: (v: number) =>
        v === 1 ? <Tag color="green">启用</Tag> : <Tag color="default">停用</Tag>,
    },
    {
      title: 'dim_map',
      dataIndex: 'dim_map',
      width: 90,
      render: (v: Record<string, string>) => `${Object.keys(v ?? {}).length} 项`,
    },
    {
      title: 'mtx_map',
      dataIndex: 'mtx_map',
      width: 90,
      render: (v: Record<string, string>) => `${Object.keys(v ?? {}).length} 项`,
    },
    {
      title: '租户白名单',
      dataIndex: 'acl',
      width: 220,
      render: (acl: DatasourceConfig['acl']) => {
        const list = acl?.tenants ?? [];
        const cols = Object.keys(acl?.col_tenants ?? {});
        if (list.length === 0 && cols.length === 0) {
          return <Typography.Text type="secondary">不限制</Typography.Text>;
        }
        return (
          <Space direction="vertical" size={2}>
            {list.length > 0 && (
              <Space size={4} wrap>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>数据源</Typography.Text>
                {list.map((t) => (
                  <Tag key={t} color="blue">{t}</Tag>
                ))}
              </Space>
            )}
            {cols.length > 0 && (
              <Space size={4} wrap>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>列</Typography.Text>
                {cols.map((c) => (
                  <Tooltip key={c} title={`${c}: ${(acl?.col_tenants?.[c] ?? []).join('、')}`}>
                    <Tag color="geekblue">{c}</Tag>
                  </Tooltip>
                ))}
              </Space>
            )}
          </Space>
        );
      },
    },
    {
      title: 'mid_sql',
      dataIndex: 'mid_sql',
      ellipsis: true,
      render: (v: string) => (
        <Tooltip title={v.slice(0, 500)} placement="topLeft">
          <Typography.Text type="secondary">{v.replace(/\s+/g, ' ').slice(0, 80)}</Typography.Text>
        </Tooltip>
      ),
    },
    {
      title: '更新人',
      dataIndex: 'updated_by',
      width: 110,
    },
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
      render: (_: unknown, record: DatasourceConfig) => (
        <Space size="small">
          <Button type="link" size="small" onClick={() => onEdit(record)}>
            编辑
          </Button>
          <Popconfirm
            title={`确认删除 ${record.datasource_key}？`}
            description="软删除，配置会从列表移除。"
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

  return (
    <div>
      <Space style={{ marginBottom: 16 }} wrap>
        <Input.Search
          allowClear
          placeholder="按 key 或名称搜索"
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
          新建配置
        </Button>
      </Space>

      <Table
        rowKey="datasource_key"
        loading={loading}
        columns={columns}
        dataSource={items}
        scroll={{ x: 1200 }}
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

      <EditDrawer
        open={drawerOpen}
        record={editing}
        onClose={() => setDrawerOpen(false)}
        onSaved={() => {
          setDrawerOpen(false);
          void load();
        }}
      />
    </div>
  );
}
