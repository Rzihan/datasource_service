import { useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Alert, Breadcrumb, Button, Card, Empty, Space, Table, Tag, Typography } from 'antd';
import type { Dashboard, QueryDataset } from '../types';
import { findLegacyPage } from '../utils/legacyPages';
import { collectAllEntries } from '../utils/entries';
import MigrationBanner from '../components/MigrationBanner';
import { recordVisit } from '../utils/migration';

interface Props {
  datasets: QueryDataset[];
  dashboards?: Dashboard[];
}

// 存量页面：系统里那些写死的表格页 / 看板页。
//
// 本仓库里没有真正的历史页面，这几个是照着「每天打开、表头固定、口径写死」
// 的样子搭出来的替身，用来演示可视化查询要怎么接进去。真实接入时，
// 迁移相关的部分（菜单挂载、迁移引导、状态机）都作用在你们自己的页面上。
export default function LegacyPage({ datasets, dashboards = [] }: Props) {
  const { pageKey } = useParams();
  const page = findLegacyPage(pageKey);
  const entries = collectAllEntries(datasets, dashboards).filter((e) => e.legacy === pageKey);

  // 记一次「旧页被打开」：这是迁移看板上「还有多少人在用旧页」的分子
  useEffect(() => {
    if (pageKey) recordVisit(pageKey, 'legacy');
  }, [pageKey]);

  if (!page) {
    return (
      <Card size="small">
        <Empty description={`没有找到存量页面「${pageKey}」`} />
      </Card>
    );
  }

  return (
    <div>
      <Breadcrumb style={{ fontSize: 12 }} items={[{ title: page.module }, { title: page.title }]} />
      <div style={{ marginTop: 6, marginBottom: 12 }}>
        <Typography.Title level={5} style={{ margin: 0, display: 'inline-block', marginRight: 8 }}>
          {page.title}
        </Typography.Title>
        <Tag>存量页面</Tag>
      </div>
      {/* 旧页已被替代：菜单上已经没有这一页了，能走到这里的多半是从旧链接/收藏进来的，
          所以要说清楚去哪儿，而不是让他看到一张还能用的表、以为一切照旧。 */}
      {entries[0]?.status === 'replaced' ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="这一页已由可视化查询版替代"
          description={
            <Space size={6}>
              <Typography.Text style={{ fontSize: 13 }}>
                菜单里已经换成新版（同一份数据，可以自己换维度、加筛选）
              </Typography.Text>
              <Link to={entries[0].href}>
                <Button type="primary" size="small">
                  {entries[0].kind === 'dashboard' ? '去新版大盘' : '去可视化查询版'}
                </Button>
              </Link>
            </Space>
          }
        />
      ) : (
        <>
          {/* 引导出现在他正在看的这一页上：迁移不能只靠菜单里多了一项，
              用户每天的路径是肌肉记忆，他不会主动去看菜单多了什么。 */}
          {entries[0] && <MigrationBanner entry={entries[0]} />}
        </>
      )}
      <Card size="small" title={page.title} extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>固定口径 · 不可改</Typography.Text>}>
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 0 }}>
          {page.desc}
        </Typography.Paragraph>
        <Table
          size="small"
          pagination={false}
          rowKey={(r) => r.cells.join('|')}
          dataSource={page.rows.map((r) => ({ cells: r }))}
          columns={page.columns.map((c, i) => ({
            title: c,
            dataIndex: ['cells', i],
            render: (v: string) => v,
          }))}
        />
      </Card>
      {entries.length > 0 && (
        <Card size="small" style={{ marginTop: 12 }} title="这一页的迁移状态">
          {entries.map((e) => (
            <div key={e.key} style={{ fontSize: 13 }}>
              <Link to={e.href}>{e.title}（{e.kind === 'dashboard' ? '大盘版' : '可视化查询版'}）</Link>
              <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                {e.kind === 'dashboard' ? '一屏多面板，跨数据集' : `挂在数据集 ${e.datasetKey}`}
              </Typography.Text>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
