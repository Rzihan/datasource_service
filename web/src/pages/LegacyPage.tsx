import { Link, useParams } from 'react-router-dom';
import { Breadcrumb, Card, Empty, Table, Tag, Typography } from 'antd';
import type { QueryDataset } from '../types';
import { findLegacyPage } from '../utils/legacyPages';
import { collectEntries } from '../utils/entries';

interface Props {
  datasets: QueryDataset[];
}

// 存量页面：系统里那些写死的表格页 / 看板页。
//
// 本仓库里没有真正的历史页面，这几个是照着「每天打开、表头固定、口径写死」
// 的样子搭出来的替身，用来演示可视化查询要怎么接进去。真实接入时，
// 迁移相关的部分（菜单挂载、迁移引导、状态机）都作用在你们自己的页面上。
export default function LegacyPage({ datasets }: Props) {
  const { pageKey } = useParams();
  const page = findLegacyPage(pageKey);
  const entries = collectEntries(datasets).filter((e) => e.legacy === pageKey);

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
              <Link to={`/e/${e.key}`}>{e.title}（可视化查询版）</Link>
              <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                挂在数据集 {e.datasetKey}
              </Typography.Text>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
