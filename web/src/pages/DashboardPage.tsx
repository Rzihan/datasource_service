import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Alert, Breadcrumb, Button, Card, Col, Empty, Row, Select, Skeleton, Space, Tag, Tooltip, Typography } from 'antd';
import { AppstoreOutlined, FilterOutlined, ReloadOutlined } from '@ant-design/icons';
import type { Dashboard, DashboardPanel, FilterNode, QueryDataset } from '../types';
import { fetchDashboard, fetchDimValues, fetchQueryDatasets } from '../api';
import DashboardPanelCard from '../components/DashboardPanelCard';
import { panelQuery, parseIntent } from '../utils/intent';

// 一次「点图形下钻出来的整屏筛选」。它跟顶部声明的筛选器是两回事：
// 声明的是作者钉好的常用维度，这个是看的人临时追问「这个柱子是谁」。
interface CrossFilter {
  field: string;
  value: string;
  from: string;
}

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

  // 顶部筛选器的当前值。key 是字段名而不是下标：
  // 作者增删筛选器时，已选的值不该跟着错位。
  const [filterValues, setFilterValues] = useState<Record<string, string>>({});
  const [crossFilters, setCrossFilters] = useState<CrossFilter[]>([]);
  const [options, setOptions] = useState<Record<string, string[]>>({});

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

  // 筛选器的候选值从真实数据里取。手敲的候选值会跟数据脱节——
  // 新增了一个团队，下拉里却没有，筛选器就变成了「看起来能筛实际筛不到」。
  useEffect(() => {
    const list = dashboard?.filters ?? [];
    if (list.length === 0) return;
    let cancelled = false;
    void Promise.all(
      list.map((f) =>
        f.dataset
          ? fetchDimValues(f.dataset, f.field)
              .then((res) => [f.field, res.values ?? []] as [string, string[]])
              .catch(() => [f.field, []] as [string, string[]])
          : Promise.resolve([f.field, []] as [string, string[]]),
      ),
    ).then((pairs) => {
      if (!cancelled) setOptions(Object.fromEntries(pairs));
    });
    return () => {
      cancelled = true;
    };
  }, [dashboard]);

  // 打开大盘时带着默认值：让人先看到一张有内容的图，
  // 再决定要不要换筛选，而不是先面对三个空下拉。
  useEffect(() => {
    if (!dashboard) return;
    const init: Record<string, string> = {};
    for (const f of dashboard.filters ?? []) {
      if (f.default) init[f.field] = f.default;
    }
    setFilterValues((prev) => (Object.keys(prev).length > 0 ? prev : init));
  }, [dashboard]);

  const byKey = useMemo(() => new Map(datasets.map((d) => [d.dataset_key, d])), [datasets]);

  // 面板有没有某个字段：整屏筛选只作用在有这个字段的面板上。
  // 没有这个筛选维度的面板被强行带上条件，会直接查空——
  // 「我筛了个团队，结果半张大盘空了」是联动最常见的翻车方式。
  const hasField = (ds: QueryDataset | undefined, field: string): boolean =>
    !!ds && (field in ds.dim_map || field in ds.multi_dim_map);

  const extraFor = useCallback(
    (panel: DashboardPanel): FilterNode | null => {
      if (panel.follow === false) return null;
      const ds = byKey.get(panel.dataset);
      if (!ds) return null;
      const leaves: FilterNode[] = [];
      for (const f of dashboard?.filters ?? []) {
        const v = filterValues[f.field];
        if (v && hasField(ds, f.field)) leaves.push({ field: f.field, op: '=', value: v });
      }
      for (const c of crossFilters) {
        if (hasField(ds, c.field)) leaves.push({ field: c.field, op: '=', value: c.value });
      }
      if (leaves.length === 0) return null;
      return { logic: 'and', children: leaves };
    },
    [byKey, dashboard, filterValues, crossFilters],
  );

  // 点图形 → 把它对应的类目变成整屏筛选。
  // 这是大盘相对「一张静态图」最值钱的地方：看到异常的那根柱子，
  // 下一步自然是「那其他指标在这一类目下是什么样」。
  const onPointClick = (panel: DashboardPanel, x: string) => {
    const ds = byKey.get(panel.dataset);
    if (!ds) return;
    const dims = parseIntent(ds, panelQuery(ds, panel.query)).dims;
    const field = panel.emit_filter || dims[0];
    if (!field || x === '(空值)') return;
    setCrossFilters((prev) => [...prev.filter((c) => c.field !== field), { field, value: x, from: panel.title || panel.id }]);
  };

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

  const missing = dashboard.panels.filter((p) => !byKey.has(p.dataset)).map((p) => p.dataset);
  const filters = dashboard.filters ?? [];
  const followCount = dashboard.panels.filter((p) => p.follow !== false).length;
  const noFollowCount = dashboard.panels.length - followCount;
  const activeCount = Object.values(filterValues).filter(Boolean).length + crossFilters.length;

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

      {/* 整屏筛选。它回答的是「这一屏能不能一起收窄」——
          没有它，大盘只是一堆互不相干的图拼在一起。 */}
      {(filters.length > 0 || crossFilters.length > 0) && (
        <Card size="small" style={{ marginBottom: 12 }} styles={{ body: { padding: '8px 12px' } }}>
          <Space size={8} wrap align="center">
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              <FilterOutlined /> 整屏筛选
            </Typography.Text>
            {filters.map((f) => (
              <Select
                key={f.field}
                size="small"
                style={{ minWidth: 140 }}
                placeholder={f.label || f.field}
                allowClear
                value={filterValues[f.field] || undefined}
                onChange={(v) => setFilterValues((prev) => ({ ...prev, [f.field]: v ?? '' }))}
                options={(options[f.field] ?? []).map((v) => ({ value: v, label: v }))}
              />
            ))}
            {crossFilters.map((c) => (
              <Tag key={c.field} closable color="blue" onClose={() => setCrossFilters((prev) => prev.filter((x) => x.field !== c.field))}>
                {c.field} = {c.value}
                <Tooltip title={`来自面板「${c.from}」：点图形下钻出来的`}>
                  <span style={{ marginLeft: 4, opacity: 0.75 }}>下钻</span>
                </Tooltip>
              </Tag>
            ))}
            {activeCount > 0 && (
              <Button
                size="small"
                type="link"
                onClick={() => {
                  setFilterValues({});
                  setCrossFilters([]);
                }}
              >
                清空筛选
              </Button>
            )}
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {activeCount > 0
                ? `${followCount} 个面板跟随${noFollowCount > 0 ? `、${noFollowCount} 个不跟随` : ''}`
                : '点面板里的图形可以把它下钻成整屏筛选'}
            </Typography.Text>
          </Space>
        </Card>
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
          {dashboard.panels.map((p) => {
            const extra = extraFor(p);
            const note = extra
              ? [
                  ...filters.filter((f) => filterValues[f.field]).map((f) => `${f.label || f.field}=${filterValues[f.field]}`),
                  ...crossFilters.map((c) => `${c.field}=${c.value}`),
                ].join('、')
              : undefined;
            return (
              // 后端存的是 12 栅格，antd 是 24 栅格，乘 2 对齐
              <Col key={p.id} span={Math.min(Math.max(p.span, 1), 12) * 2}>
                <DashboardPanelCard
                  panel={p}
                  dataset={byKey.get(p.dataset)}
                  extraFilter={extra}
                  filterNote={note}
                  noFollow={p.follow === false}
                  onPointClick={onPointClick}
                />
              </Col>
            );
          })}
        </Row>
      )}
    </div>
  );
}
