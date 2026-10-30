import { useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Breadcrumb, Button, Card, Empty, Space, Spin, Tag, Tooltip, Typography } from 'antd';
import { ArrowLeftOutlined, AppstoreOutlined } from '@ant-design/icons';
import QueryPage from './QueryPage';
import type { QueryDataset } from '../types';
import { collectEntries, findEntry, statusText } from '../utils/entries';

interface Props {
  datasets: QueryDataset[];
}

// 挂载在旧菜单下的可视化查询入口。
//
// 它存在的全部意义是：历史用户点他熟悉的菜单就能到新版，不用先去可视化查询页、
// 再在数据集列表里认出哪个是自己原来那张表。所以这一页刻意不提供「换数据集」，
// 查询能力照旧——少的只是那个他本来就不会动的入口。
export default function EntryPage({ datasets }: Props) {
  const { entryKey } = useParams();
  const entries = useMemo(() => collectEntries(datasets), [datasets]);
  const entry = findEntry(entries, entryKey);

  if (datasets.length === 0) {
    return (
      <Card size="small">
        <Space>
          <Spin size="small" />
          <Typography.Text type="secondary">正在读取入口配置…</Typography.Text>
        </Space>
      </Card>
    );
  }

  if (!entry) {
    return (
      <Card size="small">
        <Empty
          description={
            <Space direction="vertical" size={4}>
              <Typography.Text>没有找到入口「{entryKey}」</Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                它可能已被作者取消挂载，或者这个数据集对你不可见
              </Typography.Text>
              <Link to="/query">去可视化查询页看看</Link>
            </Space>
          }
        />
      </Card>
    );
  }

  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <Breadcrumb
          style={{ fontSize: 12 }}
          items={[
            { title: entry.module },
            ...(entry.legacyPage
              ? [{ title: <Link to={`/legacy/${entry.legacyPage.key}`}>{entry.legacyPage.title}</Link> }]
              : []),
            { title: entry.title },
          ]}
        />
        <div
          style={{
            marginTop: 6,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <Space size={8} align="center" style={{ flexWrap: 'wrap' }}>
            <Typography.Title level={5} style={{ margin: 0 }}>
              {entry.title}
            </Typography.Title>
            <Tag color="blue">可视化查询</Tag>
            <Tag>{statusText(entry.status)}</Tag>
            {entry.legacyPage && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                原页面：{entry.legacyPage.title}
              </Typography.Text>
            )}
          </Space>
          {/* 出口比入口更重要：迁移最怕的是「进来了出不去」。
              不管新版多好，用户随时能退回他熟悉的那一页，他才敢留下来试。 */}
          <Space size={4}>
            {entry.legacyPage && (
              <Link to={`/legacy/${entry.legacyPage.key}`}>
                <Button size="small" icon={<ArrowLeftOutlined />}>
                  回到旧版
                </Button>
              </Link>
            )}
            <Tooltip title="这个入口锁定了数据集；要看别的数据集，去完整查询页">
              <Link to={`/query?ds=${encodeURIComponent(entry.datasetKey)}`}>
                <Button size="small" icon={<AppstoreOutlined />}>
                  全部数据集
                </Button>
              </Link>
            </Tooltip>
          </Space>
        </div>
        {entry.note && (
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: '4px 0 0' }}>
            {entry.note}
          </Typography.Paragraph>
        )}
      </div>
      <QueryPage
        locked={{
          key: entry.datasetKey,
          query: entry.defaultQuery,
          hint: `这个数据集由「${entry.title}」入口固定，换数据集请用右上角「全部数据集」`,
        }}
      />
    </div>
  );
}
