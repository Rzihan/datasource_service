import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Button, Card, Col, Empty, Row, Skeleton, Space, Tag, Tooltip, Typography } from 'antd';
import { StarFilled, StarOutlined } from '@ant-design/icons';
import type { Dashboard } from '../types';
import { fetchDashboards } from '../api';
import { fmtUsedAt, loadUsage, togglePinned, type DashUsage } from '../utils/dashboardPrefs';

// 大盘列表。刻意不做分页也不做搜索：
// 大盘是「几个页面」的量级，给它配搜索框等于承认「多到找不着」，
// 那说明该做的是收敛入口，不是加搜索。
//
// 但顺序要跟人走：我每天打开的就是那一张，它该在最上面——
// 星标置顶 + 最近打开时间（v9），都记在本地，是个人习惯不是大盘属性。
export default function DashboardList() {
  const [items, setItems] = useState<Dashboard[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [usage, setUsage] = useState<Record<string, DashUsage>>({});

  useEffect(() => {
    fetchDashboards()
      .then((res) => setItems(res.items ?? []))
      .catch((e: unknown) => setError((e as Error).message || '加载失败'))
      .finally(() => setLoading(false));
    // 使用痕迹读一次就够：本页不监听 storage，改完星标就地刷新
    setUsage(loadUsage());
  }, []);

  // 排序：星标 → 最近打开 → 后端原顺序。从未打开过的保持原样排在后面。
  const sorted = useMemo(() => {
    const arr = [...items];
    arr.sort((a, b) => {
      const ua = usage[a.key] ?? {};
      const ub = usage[b.key] ?? {};
      if (!!ua.pinned !== !!ub.pinned) return ua.pinned ? -1 : 1;
      return (ub.ts ?? 0) - (ua.ts ?? 0);
    });
    return arr;
  }, [items, usage]);

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
        对应的是这里的「一张大盘」，不是「一次查询」。点右上角的星标把常用的钉在最前面。
      </Typography.Paragraph>
      <Row gutter={[12, 12]}>
        {sorted.map((d) => {
          const u = usage[d.key] ?? {};
          const usedAt = fmtUsedAt(u.ts);
          return (
            <Col key={d.key} xs={24} sm={12} xl={8}>
              <Link to={`/d/${d.key}`} style={{ color: 'inherit' }}>
                <Card
                  size="small"
                  hoverable
                  style={{ height: '100%' }}
                  title={<Typography.Text strong>{d.title}</Typography.Text>}
                  extra={
                    // 星标在 Link 里面：点了星不能跟着跳走，要把导航拦下来
                    <Tooltip title={u.pinned ? '取消置顶' : '常用，钉在前面'}>
                      <Button
                        size="small"
                        type="text"
                        icon={u.pinned ? <StarFilled style={{ color: '#faad14' }} /> : <StarOutlined />}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          togglePinned(d.key);
                          setUsage(loadUsage());
                        }}
                      />
                    </Tooltip>
                  }
                >
                  <Space direction="vertical" size={4} style={{ width: '100%' }}>
                    <Space size={6} wrap>
                      <Tag>{d.panels.length} 个面板</Tag>
                      {u.pinned && (
                        <Tag color="gold" style={{ marginInlineEnd: 0 }}>
                          常用
                        </Tag>
                      )}
                    </Space>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {d.module || '未分组'}
                      {d.owner ? ` · ${d.owner}` : ''}
                      {usedAt ? ` · 最近打开 ${usedAt}` : ''}
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
          );
        })}
      </Row>
    </div>
  );
}
