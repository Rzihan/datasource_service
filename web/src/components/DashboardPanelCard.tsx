import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Empty, Skeleton, Space, Table, Tag, Tooltip, Typography } from 'antd';
import { DatabaseOutlined, ExpandOutlined, InfoCircleOutlined, RedoOutlined } from '@ant-design/icons';
import type { DashboardPanel, QueryDataset, QueryResult, StringMap } from '../types';
import { executeQuery } from '../api';
import type { FilterNode } from '../types';
import { pruneEmpty } from '../utils/filterTree';
import { abbrText } from '../utils/format';
import { toNumber } from '../utils/number';
import { panelQuery, parseIntent } from '../utils/intent';
import { buildPanelData } from '../utils/panelData';
import Sparkline from './Sparkline';

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
  // 编辑态下挂在卡片右上角的操作（改 / 删）。放在外面而不是卡片自己决定：
  // 「能不能编辑」是大盘的事，不是面板的事。
  actions?: React.ReactNode;
  // 放大：把这一块弹到大尺寸里单独读。常在「这一块看着不对，想看清楚」时用。
  onFocus?: () => void;
  // 紧凑布局：收窄卡片内边距、指标主数字略小。大盘切到「紧凑」档时整屏过一遍。
  dense?: boolean;
  // 把结果回报给大盘：整屏导出要按面板分段写，
  // 而数据是面板自己取的，大盘拿不到。
  onDone?: (info: PanelResult) => void;
  // 作者把这个面板设成不跟随整屏筛选。必须显示出来：
  // 收窄之后唯独这一块数字没变，用户会以为筛选坏了。
  noFollow?: boolean;
}

// 面板跑完之后的交付物。大盘用它做两件事：
// 顶部那句「几块就绪」的汇总，以及整屏导出（每个面板一段，各带自己的口径）。
export interface PanelResult {
  id: string;
  title: string;
  result: QueryResult | null;
  dims: string[];
  metrics: string[];
  labelMap: StringMap;
  error: string;
  filterText: string;
  elapsedMs: number;
  truncated: boolean;
}

export default function DashboardPanelCard({
  panel,
  dataset,
  extraFilter,
  onPointClick,
  filterNote,
  noFollow,
  actions,
  onFocus,
  dense,
  onDone,
}: Props) {
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  // 单块重试：整屏八块里挂了一块，不该让人把整屏刷新一遍
  const [retry, setRetry] = useState(0);
  // 指标卡的趋势线。一个总数没有方向感——不知道它在涨还是在跌，
  // 也不知道这个量级在最近是不是正常。有 date 维度才补这一条。
  const [trend, setTrend] = useState<number[]>([]);

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
  }, [queryKey, dataset, retry]);

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

  // 指标卡补一条日趋势：只用来画 sparkline 与算「较昨日」。
  // 条件收得紧——只有「指标卡 + 没有自己的维度（即一个总数）+ 数据集有 date 维度」
  // 才值得多跑一次查询；否则宁可让卡片保持朴素，也不为一条没意义的折线加一次往返。
  const trendField = panel.metric || metrics[0];
  const wantsTrend =
    panel.view === 'metric' && dims.length === 0 && !!dataset && !!dataset.dim_map?.date && !!trendField;
  useEffect(() => {
    if (!wantsTrend || !dataset) {
      setTrend([]);
      return;
    }
    let cancelled = false;
    const it = parseIntent(dataset, panelQuery(dataset, panel.query));
    const leaves: FilterNode[] = [];
    if (it.filterTree) leaves.push(it.filterTree);
    if (extraFilter) leaves.push(extraFilter);
    void executeQuery({
      dataset_key: dataset.dataset_key,
      dims: ['date'],
      metrics: [trendField as string],
      filter: leaves.length > 0 ? pruneEmpty({ logic: 'and', children: leaves }) ?? undefined : undefined,
      order_by: [{ field: 'date', desc: false }],
      limit: 500,
    })
      .then((res) => {
        if (cancelled) return;
        const idx = res.columns.findIndex((c) => c.name === trendField);
        setTrend(idx < 0 ? [] : res.rows.map((r) => toNumber(r[idx]) ?? 0));
      })
      .catch(() => {
        if (!cancelled) setTrend([]);
      });
    return () => {
      cancelled = true;
    };
  }, [wantsTrend, dataset, panel.query, trendField, extraFilter]);

  // 较昨日：趋势最后两天的相对变化。前一日为 0 时不出环比——
  // 除以 0 得到的「增长了 ∞%」比不显示更容易误读。
  const delta = useMemo(() => {
    if (trend.length < 2) return null;
    const last = trend[trend.length - 1];
    const prev = trend[trend.length - 2];
    if (!prev) return null;
    return { pct: ((last - prev) / Math.abs(prev)) * 100, up: last >= prev };
  }, [trend]);

  // 回报结果：导出与「几块就绪」都靠它。维度名用中文（labelMap 由大盘侧翻译）。
  useEffect(() => {
    if (!onDone) return;
    onDone({
      id: panel.id,
      title: panel.title || '',
      result,
      dims,
      metrics,
      labelMap,
      error,
      filterText: filterNote ?? '',
      elapsedMs: result?.elapsed_ms ?? 0,
      truncated: !!result?.truncated,
    });
  }, [result, error, dims, metrics, labelMap, filterNote, panel.id, panel.title, onDone]);

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
      return (
        <Alert
          type="error"
          showIcon
          style={{ margin: 8 }}
          message="这一块没跑出来"
          description={
            <Space direction="vertical" size={4}>
              <span>{error}</span>
              <Button size="small" icon={<RedoOutlined />} onClick={() => setRetry((v) => v + 1)}>
                重试这一块
              </Button>
            </Space>
          }
        />
      );
    }
    if (!result || !data) {
      return <Empty description="暂无数据" style={{ marginTop: 24 }} />;
    }
    if (panel.view === 'metric') {
      // 主数字给缩写（2,521,531,570 → 25.22 亿），完整值放 tooltip：
      // 缩写用于扫视，精确值用于核对，两件事不该挤在同一个字号里。
      const short = abbrText(data.totalText);
      return (
        <div style={{ padding: '4px 4px', display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Tooltip title={`完整值 ${data.totalText}`}>
            <div
              style={{
                fontSize: dense ? 24 : 28,
                fontWeight: 600,
                lineHeight: 1.18,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {short}
            </div>
          </Tooltip>
          <Typography.Text type="secondary" style={{ fontSize: 12 }} ellipsis>
            {panel.metric ? labelMap[panel.metric] || panel.metric : metrics.map((m) => labelMap[m] || m).join(' / ')}
            {!data.additive && ' · 行均值'}
          </Typography.Text>
          <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 8, marginTop: 2 }}>
            {trend.length >= 2 ? (
              <Tooltip title={`近 ${trend.length} 日每日趋势`}>
                <span style={{ display: 'inline-flex' }}>
                  <Sparkline values={trend} width={118} height={30} />
                </span>
              </Tooltip>
            ) : (
              <span />
            )}
            <div style={{ textAlign: 'right', lineHeight: 1.25 }}>
              {delta && (
                <div style={{ fontSize: 12, color: '#595959', whiteSpace: 'nowrap' }}>
                  {delta.up ? '▲' : '▼'} 较昨日 {Math.abs(delta.pct).toFixed(1)}%
                </div>
              )}
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                {trend.length >= 2 ? `近 ${trend.length} 日` : `${data.rowCount} 行${data.truncated ? ' · 已截断' : ''}`}
              </Typography.Text>
            </div>
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
          {panel.note && (
            <Tooltip title={panel.note}>
              <InfoCircleOutlined style={{ color: '#8c8c8c', cursor: 'help' }} />
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
        <Space size={6}>
          {onFocus && (
            <Tooltip title="放大这一块">
              <Button size="small" type="text" icon={<ExpandOutlined />} onClick={onFocus} />
            </Tooltip>
          )}
          {actions}
          {result?.truncated && (
            <Tooltip title="结果被截断了：这一块看到的不是全量，下结论前要留意">
              <Tag color="orange" style={{ marginInlineEnd: 0 }}>
                截断
              </Tag>
            </Tooltip>
          )}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {VIEW_LABEL[panel.view]}
          </Typography.Text>
        </Space>
      }
      styles={{ body: { height: panel.height, overflow: 'auto', padding: dense ? 4 : 8 } }}
      style={{ height: '100%' }}
    >
      {body()}
      {result && panel.view !== 'metric' && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {result.row_count} 行 · {result.elapsed_ms} ms
          {filterNote ? ` · ${filterNote}` : ''}
        </Typography.Text>
      )}
    </Card>
  );
}
