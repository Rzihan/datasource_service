import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { Alert, Card, Empty, Skeleton, Space, Table, Tag, Tooltip, Typography } from 'antd';
import { DatabaseOutlined } from '@ant-design/icons';
import type { DashboardPanel, QueryDataset, QueryResult, StringMap } from '../types';
import { executeQuery } from '../api';
import type { FilterNode } from '../types';
import { pruneEmpty } from '../utils/filterTree';
import { panelQuery, parseIntent } from '../utils/intent';
import { buildPanelData } from '../utils/panelData';

// 与查询页同一份懒加载：图表库 400KB+，大盘一屏六七个面板，
// 谁都不该为了看数字先把整包图表库下下来。
const ChartView = lazy(() => import('./ChartView'));

const VIEW_LABEL: Record<DashboardPanel['view'], string> = {
  table: '明细表',
  metric: '指标卡',
  line: '折线图',
  column: '柱状图',
  pie: '饼图',
};

interface Props {
  panel: DashboardPanel;
  // 数据集可能已经被改名或删除——面板写的是 key，取不到时要说清楚是配置失效，
  // 而不是报一个通用的「查询失败」，否则作者会去查数据而不是查配置。
  dataset?: QueryDataset;
  // 大盘级筛选（v32）：以 FilterNode 形式叠加到面板自己的条件上
  extraFilter?: FilterNode | null;
  // 点图形元素 → 由外层决定做什么（联动筛选 / 跳查询页）
  onPointClick?: (panel: DashboardPanel, x: string) => void;
  // 面板被大盘筛选影响时，角标上要说一句，否则「这个数怎么变小了」无从解释
  filterNote?: string;
  // 作者把这个面板设成不跟随整屏筛选。必须显示出来：
  // 收窄之后唯独这一块数字没变，用户会以为筛选坏了。
  noFollow?: boolean;
}

export default function DashboardPanelCard({
  panel,
  dataset,
  extraFilter,
  onPointClick,
  filterNote,
  noFollow,
}: Props) {
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // 面板的查询串。数据集变了（改名/字段删了）时要重跑，所以放进依赖。
  const queryKey = useMemo(() => {
    const sp = dataset ? panelQuery(dataset, panel.query) : new URLSearchParams();
    if (extraFilter) {
      // 大盘筛选走单独一个参数，不与面板自己的条件混在一起：
      // 面板自带的条件是作者调好的口径，不该被整屏筛选改写掉。
      sp.set('xfilter', JSON.stringify(extraFilter));
    }
    return sp.toString();
  }, [dataset, panel.query, extraFilter]);

  useEffect(() => {
    if (!dataset) {
      setResult(null);
      return;
    }
    let cancelled = false;
    const sp = new URLSearchParams(queryKey);
    const rawX = sp.get('xfilter');
    const intent = parseIntent(dataset, sp);
    if (rawX) {
      try {
        const node = JSON.parse(rawX) as FilterNode;
        // 大盘筛选与面板条件并列（and），不是替换：
        // 面板自己的口径要保住，整屏筛选只做收窄。
        intent.filterTree = {
          logic: 'and',
          children: [intent.filterTree, node],
        };
      } catch {
        // 解析不出来就按没筛选跑，总比整块面板报错好
      }
    }
    setLoading(true);
    setError('');
    void executeQuery({
      dataset_key: intent.key,
      dims: intent.dims,
      metrics: intent.metrics,
      filter: pruneEmpty(intent.filterTree) ?? undefined,
      order_by: intent.orderBy ? [intent.orderBy] : [],
      limit: intent.limit,
      compare: intent.compare ?? undefined,
    })
      .then((res) => {
        if (!cancelled) setResult(res);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setResult(null);
          setError((e as Error).message || '查询失败');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [queryKey, dataset]);

  const labelMap: StringMap = dataset?.label_map ?? {};
  // 面板自己的条件：只取 dims / metrics 用来画图与算主数字，
  // 真正执行时在上面那个 effect 里与大盘筛选合并。
  const baseIntent = useMemo(
    () => (dataset ? parseIntent(dataset, panelQuery(dataset, panel.query)) : null),
    [dataset, panel.query],
  );
  const dims = baseIntent?.dims ?? [];
  const metrics = baseIntent?.metrics ?? [];
  const data = useMemo(
    () => (result ? buildPanelData(result, dims, metrics, labelMap) : null),
    [result, dims, metrics, labelMap],
  );

  const bodyHeight = Math.max(panel.height - 92, 96);

  const title = panel.title || (metrics.length > 0 ? metrics.map((m) => labelMap[m] || m).join(' / ') : panel.dataset);

  const body = () => {
    if (!dataset) {
      return (
        <Empty
          image={<DatabaseOutlined style={{ fontSize: 28, color: '#bfbfbf' }} />}
          description={`数据集 ${panel.dataset} 不存在或已下线`}
          style={{ marginTop: 24 }}
        />
      );
    }
    if (loading && !result) {
      return <Skeleton active paragraph={{ rows: 3 }} style={{ padding: 12 }} />;
    }
    if (error) {
      return <Alert type="error" showIcon message="这一块没跑出来" description={error} style={{ margin: 8 }} />;
    }
    if (!result || !data) {
      return <Empty description="暂无数据" style={{ marginTop: 24 }} />;
    }
    if (panel.view === 'metric') {
      return (
        <div style={{ padding: '8px 4px' }}>
          <div style={{ fontSize: 30, fontWeight: 600, lineHeight: 1.2 }}>{data.totalText}</div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {panel.metric ? labelMap[panel.metric] || panel.metric : metrics.map((m) => labelMap[m] || m).join(' / ')}
            {!data.additive && ' · 行均值'}
          </Typography.Text>
          <div style={{ marginTop: 6 }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {data.rowCount} 行{data.truncated ? ' · 已截断' : ''}
            </Typography.Text>
          </div>
        </div>
      );
    }
    if (panel.view === 'table') {
      return (
        <Table
          size="small"
          rowKey={(_, i) => String(i)}
          dataSource={result.rows.map((r, i) => ({ key: i, ...Object.fromEntries(r.map((v, c) => [result.columns[c].name, v])) }))}
          scroll={{ y: bodyHeight }}
          pagination={false}
          columns={result.columns.map((c) => ({
            title: labelMap[c.name] || c.name,
            dataIndex: c.name,
            ellipsis: true,
            render: (v: unknown) => (v === null || v === undefined ? <Typography.Text type="secondary">—</Typography.Text> : String(v)),
          }))}
        />
      );
    }
    if (data.points.length === 0) {
      return <Empty description="没有可画的数值" style={{ marginTop: 24 }} />;
    }
    return (
      <Suspense fallback={<Skeleton active paragraph={{ rows: 3 }} style={{ padding: 12 }} />}>
        <ChartView
          data={data.points}
          type={panel.view === 'pie' ? 'pie' : panel.view}
          series={data.series}
          height={bodyHeight}
          xCount={data.xCount}
          onPointClick={onPointClick ? (x) => onPointClick(panel, x) : undefined}
        />
      </Suspense>
    );
  };

  return (
    <Card
      size="small"
      title={
        <Space>
          <span>{title}</span>
          {filterNote && (
            <Tooltip title={filterNote}>
              <Tag color="blue" style={{ marginInlineEnd: 0, cursor: 'help' }}>
                已筛选
              </Tag>
            </Tooltip>
          )}
          {noFollow && (
            <Tooltip title="作者设定：这一块不跟随整屏筛选。它本身就是用来做横向对比的，收窄之后就没得比了">
              <Tag style={{ marginInlineEnd: 0, cursor: 'help' }}>不跟随</Tag>
            </Tooltip>
          )}
        </Space>
      }
      extra={
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {VIEW_LABEL[panel.view]}
        </Typography.Text>
      }
      styles={{ body: { height: panel.height, overflow: 'auto', padding: 8 } }}
      style={{ height: '100%' }}
    >
      {body()}
    </Card>
  );
}
