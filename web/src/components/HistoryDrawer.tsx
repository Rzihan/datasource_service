import { useCallback, useEffect, useState } from 'react';
import { App, Button, Drawer, Popconfirm, Skeleton, Space, Table, Tag, Typography } from 'antd';
import { HistoryOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { fetchHistories, rollbackDataset } from '../api';
import type { DatasetHistory } from '../types';

interface Props {
  open: boolean;
  datasetKey: string;
  onClose: () => void;
  onRolledBack: () => void;
}

const ACTION_META: Record<DatasetHistory['action'], { color: string; text: string }> = {
  create: { color: 'green', text: '新建' },
  update: { color: 'blue', text: '修改' },
  delete: { color: 'red', text: '删除' },
  rollback: { color: 'purple', text: '回滚' },
};

export default function HistoryDrawer({ open, datasetKey, onClose, onRolledBack }: Props) {
  const { message } = App.useApp();
  const [items, setItems] = useState<DatasetHistory[]>([]);
  const [loading, setLoading] = useState(false);
  const [rolling, setRolling] = useState<number | null>(null);

  const load = useCallback(async () => {
    if (!datasetKey) return;
    setLoading(true);
    try {
      const res = await fetchHistories(datasetKey);
      setItems(res.items ?? []);
    } catch (e) {
      message.error((e as Error).message || '加载历史失败');
    } finally {
      setLoading(false);
    }
  }, [datasetKey, message]);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [open, load]);

  const onRollback = async (id: number) => {
    setRolling(id);
    try {
      await rollbackDataset(datasetKey, id);
      message.success('已回滚');
      await load();
      onRolledBack();
    } catch (e) {
      message.error((e as Error).message || '回滚失败');
    } finally {
      setRolling(null);
    }
  };

  const columns: ColumnsType<DatasetHistory> = [
    {
      title: '时间',
      dataIndex: 'created_at',
      width: 170,
      render: (v: string) => dayjs(v).format('YYYY-MM-DD HH:mm:ss'),
    },
    {
      title: '动作',
      dataIndex: 'action',
      width: 90,
      render: (v: DatasetHistory['action']) => {
        const meta = ACTION_META[v] ?? { color: 'default', text: v };
        return <Tag color={meta.color}>{meta.text}</Tag>;
      },
    },
    { title: '版本', dataIndex: 'version', width: 70 },
    { title: '操作人', dataIndex: 'operator', width: 110 },
    {
      title: '操作',
      width: 120,
      render: (_: unknown, r: DatasetHistory) => (
        <Popconfirm
          title={`回滚到 ${dayjs(r.created_at).format('MM-DD HH:mm:ss')} 这版？`}
          description="当前配置会被这版快照整体覆盖，且会再记一条回滚历史，所以回滚也能再被回滚。"
          okText="回滚"
          cancelText="取消"
          onConfirm={() => onRollback(r.id)}
        >
          <Button type="link" size="small" loading={rolling === r.id}>
            回滚到此版本
          </Button>
        </Popconfirm>
      ),
    },
  ];

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={720}
      title={
        <Space>
          <HistoryOutlined />
          <span>变更历史：{datasetKey}</span>
        </Space>
      }
    >
      {loading && items.length === 0 ? (
        <Skeleton active paragraph={{ rows: 6 }} />
      ) : items.length === 0 ? (
        <Typography.Text type="secondary">
          还没有历史记录。历史从接入这张表之后开始记录，更早的变更无从追溯。
        </Typography.Text>
      ) : (
        <Table
          size="small"
          rowKey="id"
          pagination={false}
          columns={columns}
          dataSource={items}
          scroll={{ x: 560 }}
        />
      )}
    </Drawer>
  );
}
