import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Card, Col, Empty, Row, Skeleton, Space, Tag, Typography } from 'antd';
import type { Dashboard } from '../types';
import { fetchDashboards } from '../api';

// 大盘列表。刻意不做分页也不做搜索：
// 大盘是「几个页面」的量级，给它配搜索框等于承认「多到找不着」，
// 那说明该做的是收敛入口，不是加搜索。
export default function DashboardList() {
  const [items, setItems] = useState<Dashboard[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchDashboards()
      .then((res) => setItems(res.items ?? []))
      .catch((e: unknown) => setError((e as Error).message || '加载失败'))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <Card>
        <Skeleton active paragraph={{ rows: 5 }} />
      </Card>
    );
  }
  if (error) {
    return <Alert type="error" showIcon message="大盘列表加载失败" description={error} />;
  }
  if (items.length === 0) {
    return (
      <Card>
        <Empty description="还没有大盘。先在查询页调好一屏，再把它加进一张大盘里" />
      </Card>
    );
  }

  return (
    <div>
      <Typography.Title level={5} style={{ marginTop: 0 }}>
        仪表盘
      </Typography.Title>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        一屏多个面板，每个面板是一次可视化查询。旧的大盘页（上面指标、中间趋势、下面明细）
        对应的是这里的「一张大盘」，不是「一次查询」。
      </Typography.Paragraph>
      <Row gutter={[12, 12]}>
        {items.map((d) => (
          <Col key={d.key} xs={24} sm={12} xl={8}>
            <Link to={`/d/${d.key}`} style={{ color: 'inherit' }}>
              <Card size="small" hoverable style={{ height: '100%' }}>
                <Space direction="vertical" size={4} style={{ width: '100%' }}>
                  <Space size={6} wrap>
                    <Typography.Text strong>{d.title}</Typography.Text>
                    <Tag>{d.panels.length} 个面板</Tag>
                  </Space>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {d.module || '未分组'}
                    {d.owner ? ` · ${d.owner}` : ''}
                  </Typography.Text>
                  {d.desc && (
                    <Typography.Paragraph
                      type="secondary"
                      style={{ fontSize: 12, margin: 0 }}
                      ellipsis={{ rows: 2 }}
                    >
                      {d.desc}
                    </Typography.Paragraph>
                  )}
                </Space>
              </Card>
            </Link>
          </Col>
        ))}
      </Row>
    </div>
  );
}
