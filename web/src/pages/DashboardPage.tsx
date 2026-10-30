import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Alert, Breadcrumb, Button, Card, Col, Empty, Row, Skeleton, Space, Tag, Typography } from 'antd';
import { AppstoreOutlined, ReloadOutlined } from '@ant-design/icons';
import type { Dashboard, QueryDataset } from '../types';
import { fetchDashboard, fetchQueryDatasets } from '../api';
import DashboardPanelCard from '../components/DashboardPanelCard';

// 大盘：一屏多面板。
//
// 它不是「一次查询的另一种画法」，而是把「一个旧页面」还原出来的单位：
// 旧的大盘页上面一排指标、中间趋势图、下面明细表，三块东西来自三次查询。
// 单个可视化查询只能替代其中一块，所以替换不了一个页面——大盘才是对位的那个。
export default function DashboardPage() {
  const { dashKey = '' } = useParams();
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [datasets, setDatasets] = useState<QueryDataset[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  // 整屏刷新：面板各自取数，但「我现在就要最新」是一个整屏动作，
  // 挨个面板点刷新等于让人重复做同一件事。
  const [reloadToken, setReloadToken] = useState(0);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    Promise.all([fetchDashboard(dashKey), fetchQueryDatasets()])
      .then(([d, ds]) => {
        setDashboard(d);
        setDatasets(ds.items ?? []);
      })
      .catch((e: unknown) => {
        setDashboard(null);
        setError((e as Error).message || '加载失败');
      })
      .finally(() => setLoading(false));
  }, [dashKey]);

  useEffect(() => {
    void load();
  }, [load, reloadToken]);

  if (loading && !dashboard) {
    return (
      <Card>
        <Skeleton active paragraph={{ rows: 6 }} />
      </Card>
    );
  }
  if (error || !dashboard) {
    return <Alert type="error" showIcon message="这张大盘打不开" description={error || '不存在或已下线'} />;
  }

  const byKey = new Map(datasets.map((d) => [d.dataset_key, d]));
  const missing = dashboard.panels.filter((p) => !byKey.has(p.dataset)).map((p) => p.dataset);

  return (
    <div>
      <Breadcrumb style={{ fontSize: 12 }} items={[{ title: dashboard.module || '仪表盘' }, { title: dashboard.title }]} />
      <div style={{ marginTop: 6, marginBottom: 12, display: 'flex', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
        <Typography.Title level={5} style={{ margin: 0 }}>
          {dashboard.title}
        </Typography.Title>
        <Tag color="geekblue">{dashboard.panels.length} 个面板</Tag>
        {dashboard.owner && <Tag>负责人：{dashboard.owner}</Tag>}
        <div style={{ flex: 1 }} />
        <Space size={4}>
          <Button size="small" icon={<ReloadOutlined />} onClick={() => setReloadToken((v) => v + 1)}>
            整屏刷新
          </Button>
          <Link to="/dashboards">
            <Button size="small" icon={<AppstoreOutlined />}>
              全部大盘
            </Button>
          </Link>
        </Space>
      </div>
      {dashboard.desc && (
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 12 }}>
          {dashboard.desc}
        </Typography.Paragraph>
      )}
      {missing.length > 0 && (
        // 数据集失效是配置问题，不是数据问题。不点破的话，
        // 作者会以为是数仓挂了，然后去查一条根本不存在的线索。
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message={`有 ${missing.length} 个面板的数据集取不到：${[...new Set(missing)].join('、')}`}
          description="通常是数据集改名或被下线了，去配置管理里改这个面板的数据集即可。"
        />
      )}
      {dashboard.panels.length === 0 ? (
        <Card>
          <Empty description="这张大盘还没有面板" />
        </Card>
      ) : (
        <Row gutter={[12, 12]}>
          {dashboard.panels.map((p) => (
            // 后端存的是 12 栅格，antd 是 24 栅格，乘 2 对齐
            <Col key={p.id} span={Math.min(Math.max(p.span, 1), 12) * 2}>
              <DashboardPanelCard panel={p} dataset={byKey.get(p.dataset)} />
            </Col>
          ))}
        </Row>
      )}
    </div>
  );
}
