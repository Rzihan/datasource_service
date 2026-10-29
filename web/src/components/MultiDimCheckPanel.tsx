import { useCallback, useEffect, useState } from 'react';
import { App, Button, Empty, Popconfirm, Skeleton, Space, Table, Tag, Tooltip, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { fetchMultiDimCheck, fetchOne, migrateMultiDim } from '../api';
import type { MultiDimCandidate } from '../types';

// 这个面板解决的是「存量怎么办」。
//
// multi_dim_map 是后来才有的字段类型，而多值维度早就存在——它们被塞在 mtx_map 里
// 当指标顶着（dim_map 放不下，因为不能进 GROUP BY）。光给出正确的地方不够，
// 还得把已经配错的找出来，并给一条不用手抄表达式的迁移路径。
//
// 扫描只给建议，不自动改：一个字段算不算多值维度是业务判断，机器猜不了。
export default function MultiDimCheckPanel({ onMigrated }: { onMigrated?: () => void }) {
  const { message } = App.useApp();
  const [items, setItems] = useState<MultiDimCandidate[]>([]);
  const [scanned, setScanned] = useState(0);
  const [datasetCount, setDatasetCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchMultiDimCheck();
      setItems(res.candidates ?? []);
      setScanned(res.scanned);
      setDatasetCount(res.dataset_count);
    } catch (e) {
      message.error((e as Error).message || '检查失败');
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  // 迁移前重新拉一遍配置拿最新 version：扫描结果可能是几分钟前的，
  // 拿旧 version 去写会撞乐观锁，白点一次。
  const onMigrate = async (row: MultiDimCandidate) => {
    const id = `${row.dataset_key}/${row.field_key}`;
    setBusy(id);
    try {
      const cur = await fetchOne(row.dataset_key);
      await migrateMultiDim(row.dataset_key, {
        items: [{ field: row.field_key, expr: row.suggest_expr }],
        version: cur.version,
      });
      message.success(`${row.dataset_key} 的 ${row.field_key} 已移到 multi_dim_map`);
      await load();
      onMigrated?.();
    } catch (e) {
      const msg = (e as Error).message || '迁移失败';
      message.error(msg.includes('version conflict') ? '该配置已被他人修改，请刷新后重试' : msg);
    } finally {
      setBusy(null);
    }
  };

  if (loading && items.length === 0 && scanned === 0) {
    return <Skeleton active paragraph={{ rows: 5 }} />;
  }

  const columns: ColumnsType<MultiDimCandidate> = [
    { title: '数据集', dataIndex: 'dataset_key', width: 170, render: (v: string) => <code>{v}</code> },
    { title: '字段', dataIndex: 'field_key', width: 150, render: (v: string) => <code>{v}</code> },
    {
      title: '现在配在',
      dataIndex: 'from',
      width: 120,
      render: (v: MultiDimCandidate['from']) => (
        <Tag color={v === 'dim_map' ? 'red' : 'orange'}>{v}</Tag>
      ),
    },
    {
      title: '现在的表达式',
      dataIndex: 'expr',
      ellipsis: true,
      render: (v: string) => <Typography.Text code>{v}</Typography.Text>,
    },
    {
      title: '迁移后',
      dataIndex: 'suggest_expr',
      width: 170,
      render: (v: string, row: MultiDimCandidate) => (
        <Space direction="vertical" size={0}>
          <Typography.Text code>{v}</Typography.Text>
          {v !== row.expr && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              已剥掉收拢外壳
            </Typography.Text>
          )}
        </Space>
      ),
    },
    { title: '判定依据', dataIndex: 'reason', width: 240, render: (v: string) => (
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>{v}</Typography.Text>
    ) },
    {
      title: '操作',
      width: 150,
      render: (_: unknown, row: MultiDimCandidate) =>
        // 只有能确认迁移后表达式真的产出数组，才给一键迁移。
        // 猜错了比不迁更糟：配错之后要等下次查询才炸，排查成本高得多。
        row.confident ? (
          <Popconfirm
            title={`把 ${row.field_key} 移到 multi_dim_map？`}
            description="其余配置不动；搬完会记一条 migrate 历史，可回滚。"
            okText="迁移"
            cancelText="取消"
            onConfirm={() => void onMigrate(row)}
          >
            <Button type="link" size="small" loading={busy === `${row.dataset_key}/${row.field_key}`}>
              移到 multi_dim_map
            </Button>
          </Popconfirm>
        ) : (
          <Tooltip title="无法确认迁移后是否产出数组，请在编辑页手工改成产出数组的表达式（如直接写列名）">
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              需手工改
            </Typography.Text>
          </Tooltip>
        ),
    },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 12 }} wrap>
        <Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>
          重新检查
        </Button>
        <Typography.Text type="secondary">
          已扫描 {scanned}/{datasetCount} 个数据集（跑不通 mid_sql 的会跳过）
        </Typography.Text>
      </Space>

      {items.length === 0 ? (
        <Empty description="未发现疑似多值维度的误配" />
      ) : (
        <>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
            这些字段<strong>看着像多值维度</strong>（底层是数组列，或表达式用了数组函数），
            却配成了指标或普通维度。当指标顶着时它是维度却混在聚合函数里，语义是错的；
            当普通维度更糟——会进 <code>GROUP BY</code>，一行被拆成多行。
            <br />
            迁移会把表达式搬进 <code>multi_dim_map</code>，其余配置不动，并记一条可回滚的历史。
            注意「迁移后」那一列：以前写在指标里的多是完整收拢式，
            原样搬过去会被再包一层收拢而报错，所以会自动剥掉外壳——
            这也是只有确认迁移后确实是数组列时才给一键迁移的原因。
          </Typography.Paragraph>
          <Table
            size="small"
            rowKey={(r) => `${r.dataset_key}-${r.field_key}-${r.from}`}
            pagination={false}
            columns={columns}
            dataSource={items}
          />
        </>
      )}
    </div>
  );
}
