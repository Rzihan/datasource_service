import { useCallback, useEffect, useState } from 'react';
import { App, Button, Empty, Skeleton, Space, Table, Tag, Tooltip, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { fetchLabelCheck } from '../api';
import type {
  LabelCaseMismatch,
  LabelCheckResult,
  LabelConflict,
  LabelMissing,
  LabelOrphan,
} from '../types';

// 一致性检查是只读的：它只负责把「中文名静默不生效」的情况扫出来，
// 至于是真同名不同义（保留覆盖）还是漏同步（改全局），只能由人判断。
export default function LabelCheckPanel() {
  const { message } = App.useApp();
  const [data, setData] = useState<LabelCheckResult | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await fetchLabelCheck());
    } catch (e) {
      message.error((e as Error).message || '检查失败');
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !data) return <Skeleton active paragraph={{ rows: 6 }} />;
  if (!data) return null;

  const clean =
    data.conflicts.length === 0 &&
    data.case_mismatch.length === 0 &&
    data.missing.length === 0 &&
    data.orphans.length === 0;

  const caseCols: ColumnsType<LabelCaseMismatch> = [
    { title: '数据集', dataIndex: 'dataset_key', width: 160, render: (v: string) => <code>{v}</code> },
    { title: '数据集里的写法', dataIndex: 'field_key', width: 160, render: (v: string) => <code>{v}</code> },
    { title: '字典里的写法', dataIndex: 'global_key', width: 160, render: (v: string) => <code>{v}</code> },
    {
      title: '本该生效却没生效',
      dataIndex: 'global_label',
      width: 180,
      render: (v: string) => <Tag color="blue">{v}</Tag>,
    },
    {
      title: '怎么修',
      render: (_: unknown, r: LabelCaseMismatch) => (
        <Typography.Text type="secondary">
          把数据集的 <code>{r.field_key}</code> 改成 <code>{r.global_key}</code>，或删掉全局定义自己起名
        </Typography.Text>
      ),
    },
  ];

  const conflictCols: ColumnsType<LabelConflict> = [
    { title: '字段', dataIndex: 'field_key', width: 140, render: (v: string) => <code>{v}</code> },
    {
      title: '全局定义',
      dataIndex: 'global_label',
      width: 140,
      render: (v: string) => <Tag color="blue">{v}</Tag>,
    },
    {
      title: '数据集覆盖',
      dataIndex: 'overrides',
      render: (list: LabelConflict['overrides']) => (
        <Space size={4} wrap>
          {list.map((o) => (
            <Tooltip key={o.dataset_key} title={`${o.dataset_key} 的 label_map`}>
              <Tag color="purple">
                {o.dataset_key} → {o.label}
              </Tag>
            </Tooltip>
          ))}
        </Space>
      ),
    },
  ];

  const missingCols: ColumnsType<LabelMissing> = [
    { title: '字段', dataIndex: 'field_key', width: 160, render: (v: string) => <code>{v}</code> },
    {
      title: '涉及数据集',
      dataIndex: 'datasets',
      render: (list: string[]) => (
        <Space size={4} wrap>
          {list.map((d) => (
            <Tag key={d}>{d}</Tag>
          ))}
        </Space>
      ),
    },
  ];

  const orphanCols: ColumnsType<LabelOrphan> = [
    { title: '字段', dataIndex: 'field_key', width: 160, render: (v: string) => <code>{v}</code> },
    { title: '中文名', dataIndex: 'label', width: 160, render: (v: string) => <Tag>{v}</Tag> },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 12 }} wrap>
        <Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>
          重新检查
        </Button>
        <Typography.Text type="secondary">
          已扫描 {data.dataset_count} 个数据集、{data.global_count} 条全局定义
        </Typography.Text>
      </Space>

      {clean ? (
        <Empty description="未发现问题：全局定义与所有数据集的字段命名一致" />
      ) : (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          {data.case_mismatch.length > 0 && (
            <section>
              <Typography.Title level={5}>
                <Tag color="red">最该修</Tag>大小写不匹配 {data.case_mismatch.length} 处
              </Typography.Title>
              <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
                全局字典的 key 强制小写，数据集的 <code>dim_map</code> / <code>mtx_map</code>{' '}
                没有这个约束。写法不一致时全局定义<strong>静默失效</strong>，表头直接显示原始字段名，
                而且没有任何报错。
              </Typography.Paragraph>
              <Table
                size="small"
                rowKey={(r) => `${r.dataset_key}-${r.field_key}`}
                pagination={false}
                columns={caseCols}
                dataSource={data.case_mismatch}
              />
            </section>
          )}

          {data.conflicts.length > 0 && (
            <section>
              <Typography.Title level={5}>
                <Tag color="orange">需人工确认</Tag>与全局不一致 {data.conflicts.length} 处
              </Typography.Title>
              <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
                两种可能：一是<strong>同名不同义</strong>，数据集自己的名字是对的，保留覆盖即可；
                二是全局改了名字但这里<strong>忘了同步</strong>，应该跟着改。机器分不清，得你判断。
              </Typography.Paragraph>
              <Table
                size="small"
                rowKey="field_key"
                pagination={false}
                columns={conflictCols}
                dataSource={data.conflicts}
              />
            </section>
          )}

          {data.missing.length > 0 && (
            <section>
              <Typography.Title level={5}>
                <Tag>可补充</Tag>没有中文名 {data.missing.length} 处
              </Typography.Title>
              <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
                这些字段既没全局定义也没数据集覆盖，查询页会直接显示字段名本身。
                显式留空（不使用中文名）的不在此列。
              </Typography.Paragraph>
              <Table
                size="small"
                rowKey="field_key"
                pagination={false}
                columns={missingCols}
                dataSource={data.missing}
              />
            </section>
          )}

          {data.orphans.length > 0 && (
            <section>
              <Typography.Title level={5}>
                <Tag color="default">可清理</Tag>无人引用 {data.orphans.length} 处
              </Typography.Title>
              <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
                全局字典里定义了，但没有任何数据集用到这个字段——多半是字段改名或数据集删除后的残留。
              </Typography.Paragraph>
              <Table
                size="small"
                rowKey="field_key"
                pagination={false}
                columns={orphanCols}
                dataSource={data.orphans}
              />
            </section>
          )}
        </Space>
      )}
    </div>
  );
}
