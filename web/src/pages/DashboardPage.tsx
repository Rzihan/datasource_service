import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  Alert,
  App as AntApp,
  Breadcrumb,
  Button,
  Card,
  Col,
  Empty,
  Row,
  Select,
  Skeleton,
  Space,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  AppstoreOutlined,
  DeleteOutlined,
  EditOutlined,
  FilterOutlined,
  PlusOutlined,
  ReloadOutlined,
  DownloadOutlined,
  SaveOutlined,
  UndoOutlined,
} from '@ant-design/icons';
import type { Dashboard, DashboardPanel, FilterNode, QueryDataset } from '../types';
import { fetchDashboard, fetchDimValues, fetchQueryDatasets, updateDashboard } from '../api';
import type { PanelResult } from '../components/DashboardPanelCard';
import DashboardPanelCard from '../components/DashboardPanelCard';
import PanelEditor from '../components/PanelEditor';
import { panelQuery, parseIntent } from '../utils/intent';
import { recordVisit } from '../utils/migration';
import { findLegacyPage } from '../utils/legacyPages';

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
  // 从旧版点「立即体验」过来的：他此刻唯一的疑问是「这跟我原来那页是不是一回事」，
  // 所以先把对照摆出来。跟入口页同一个约定，不同的是这里对照的是一整屏。
  const [params] = useSearchParams();
  const [fromLegacy] = useState(() => params.get('from') === 'legacy');

  // 顶部筛选器的当前值。key 是字段名而不是下标：
  // 作者增删筛选器时，已选的值不该跟着错位。
  const [filterValues, setFilterValues] = useState<Record<string, string>>({});
  const [crossFilters, setCrossFilters] = useState<CrossFilter[]>([]);
  const [options, setOptions] = useState<Record<string, string[]>>({});

  // ── 编辑态 ──────────────────────────────────────────────────────
  // 草稿先落在本地，点保存才写库。直接改库的话，拖错一次宽度就得靠撤销接口救，
  // 而「撤销改动」对作者的心理成本远低于「再改回去再保存」。
  const { message } = AntApp.useApp();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<DashboardPanel[] | null>(null);
  const [editingPanel, setEditingPanel] = useState<DashboardPanel | null>(null);
  const [saving, setSaving] = useState(false);
  const panels = draft ?? dashboard?.panels ?? [];

  // ── 整屏可靠性 ──────────────────────────────────────────────────
  // 一屏八块，如果只给一个整屏 loading，任何一块慢都会让整屏看起来卡住；
  // 反过来，任何一块挂了也只会沉默地空着。所以状态要按块报上来、按屏汇总。
  const [panelResults, setPanelResults] = useState<Record<string, PanelResult>>({});
  const onPanelDone = useCallback((info: PanelResult) => {
    setPanelResults((prev) => ({ ...prev, [info.id]: info }));
  }, []);
  const ready = Object.values(panelResults).filter((r) => r.result).length;
  const failed = Object.values(panelResults).filter((r) => r.error).length;
  const slowest = Math.max(0, ...Object.values(panelResults).map((r) => r.elapsedMs));

  // 自动刷新：看板是「挂着看的」，不是「点开看一眼的」。
  // 但默认必须关——没人盯着的页面不该自己在后台一直查数仓。
  const [autoSeconds, setAutoSeconds] = useState(0);
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);
  useEffect(() => {
    if (autoSeconds <= 0) return;
    const timer = setInterval(() => {
      setReloadToken((v) => v + 1);
      setRefreshedAt(new Date());
    }, autoSeconds * 1000);
    return () => clearInterval(timer);
  }, [autoSeconds]);
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(dashboard?.panels ?? []);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    Promise.all([fetchDashboard(dashKey), fetchQueryDatasets()])
      .then(([d, ds]) => {
        setDashboard(d);
        setDatasets(ds.items ?? []);
        setDraft(null);
      })
      .catch((e: unknown) => {
        setDashboard(null);
        setError((e as Error).message || '加载失败');
      })
      .finally(() => {
        setLoading(false);
        setRefreshedAt(new Date());
      });
  }, [dashKey]);

  useEffect(() => {
    void load();
  }, [load, reloadToken]);

  // 记一次「新版被打开」：大盘也是迁移目标，不记的话看板会漏掉这一半，
  // 于是「还有没有人在用旧页」变成一个偏小的数字——那会让人误判为迁移失败。
  useEffect(() => {
    if (dashboard?.legacy) recordVisit(dashboard.legacy, 'entry');
  }, [dashboard]);

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

  const save = async () => {
    if (!dashboard || !draft) return;
    setSaving(true);
    try {
      const updated = await updateDashboard(dashboard.key, { panels: draft, version: dashboard.version });
      setDashboard(updated);
      setDraft(null);
      setEditing(false);
      message.success('已保存');
    } catch (e) {
      // 版本冲突是最常见的一种，单独说一句：光弹「保存失败」，作者会以为网络坏了
      const msg = (e as Error).message || '保存失败';
      message.error(msg.includes('刷新') || msg.includes('冲突') ? `${msg}（别人刚改过这张大盘）` : msg);
    } finally {
      setSaving(false);
    }
  };

  const addPanel = () => {
    const ds = datasets[0];
    if (!ds) return;
    const metrics = Object.keys(ds.mtx_map);
    const sp = new URLSearchParams();
    if (metrics.length > 0) sp.set('metrics', metrics[0]);
    sp.set('limit', '200');
    setDraft([
      ...panels,
      {
        id: `p${Date.now()}`,
        title: '',
        dataset: ds.dataset_key,
        query: sp.toString(),
        view: 'table',
        span: 6,
        height: 280,
      },
    ]);
    setEditing(true);
  };

  // 整屏导出：一个文件、按面板分段，每段带上自己的口径。
  // 收件人拿到的是「一堆数字」还是「能看懂的数」，差别就在这一段口径。
  const exportCsv = () => {
    if (!dashboard) return;
    const chunks: string[] = [];
    const stamp = new Date().toISOString();
    chunks.push(`# ${dashboard.title}`);
    chunks.push(`# 导出时间 ${stamp}`);
    if (activeCount > 0) {
      chunks.push(
        `# 整屏筛选 ${[...filters.filter((f) => filterValues[f.field]).map((f) => `${f.label || f.field}=${filterValues[f.field]}`), ...crossFilters.map((c) => `${c.field}=${c.value}`)].join('、')}`,
      );
    }
    for (const p of panels) {
      const r = panelResults[p.id];
      chunks.push('');
      chunks.push(`# ── ${p.title || p.id}（${p.view}）`);
      if (!r || (!r.result && !r.error)) {
        chunks.push('# 未取到数据（可能还在加载）');
        continue;
      }
      if (r.error) {
        chunks.push(`# 失败：${r.error}`);
        continue;
      }
      const res = r.result;
      if (!res) continue;
      chunks.push(
        `# 数据集 ${p.dataset} · 维度 ${r.dims.join('/') || '无'} · 指标 ${r.metrics.join('/') || '无'}${r.filterText ? ` · 筛选 ${r.filterText}` : ''}`,
      );
      chunks.push(res.columns.map((c) => r.labelMap[c.name] || c.name).join(','));
      for (const row of res.rows) {
        chunks.push(row.map((v) => (v === null || v === undefined ? '' : String(v))).join(','));
      }
    }
    const blob = new Blob([chunks.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${dashboard.key}-${stamp.slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    message.success('已导出整屏（每个面板一段，各带口径）');
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

  const legacyPage = findLegacyPage(dashboard?.legacy);
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
        <Tag color="geekblue">{panels.length} 个面板</Tag>
        {panels.length > 0 && (
          <Tag color={failed > 0 ? 'red' : 'green'}>
            {ready}/{panels.length} 块就绪
            {failed > 0 ? ` · ${failed} 块失败` : slowest > 0 ? ` · 最慢 ${slowest} ms` : ''}
          </Tag>
        )}
        {dirty && <Tag color="orange">未保存</Tag>}
        {dashboard.owner && <Tag>负责人：{dashboard.owner}</Tag>}
        <div style={{ flex: 1 }} />
        <Space size={4}>
          {editing ? (
            <>
              <Button size="small" icon={<PlusOutlined />} onClick={addPanel}>
                加面板
              </Button>
              <Button
                size="small"
                icon={<UndoOutlined />}
                disabled={!dirty}
                onClick={() => {
                  setDraft(null);
                  setEditing(false);
                }}
              >
                撤销改动
              </Button>
              <Button
                size="small"
                type="primary"
                icon={<SaveOutlined />}
                loading={saving}
                disabled={!dirty}
                onClick={save}
              >
                保存
              </Button>
            </>
          ) : (
            <Button size="small" icon={<EditOutlined />} onClick={() => setEditing(true)}>
              编辑
            </Button>
          )}
          <Button size="small" icon={<DownloadOutlined />} onClick={exportCsv}>
            导出整屏
          </Button>
          <Select
            size="small"
            style={{ width: 110 }}
            value={autoSeconds}
            onChange={setAutoSeconds}
            options={[
              { value: 0, label: '不自动刷新' },
              { value: 60, label: '每 1 分钟' },
              { value: 300, label: '每 5 分钟' },
              { value: 900, label: '每 15 分钟' },
            ]}
          />
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
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 4 }}>
          {dashboard.desc}
        </Typography.Paragraph>
      )}
      {refreshedAt && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          更新于 {refreshedAt.toLocaleTimeString('zh-CN')}
          {autoSeconds > 0 ? ` · 每 ${autoSeconds >= 60 ? `${autoSeconds / 60} 分钟` : `${autoSeconds} 秒`}自动刷新` : ''}
        </Typography.Text>
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

      {fromLegacy && legacyPage && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message={`这一屏替代了旧页「${legacyPage.title}」`}
          description={
            <Space direction="vertical" size={4} style={{ width: '100%' }}>
              <Typography.Text style={{ fontSize: 13 }}>
                旧页的表头是固定的（{legacyPage.columns.join('、')}）；这里每一块都能自己换维度，
                并且可以用顶部筛选让整屏一起收窄。
              </Typography.Text>
              <Link to={`/legacy/${legacyPage.key}`}>
                <Button size="small">回到旧版</Button>
              </Link>
            </Space>
          }
        />
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
      {panels.length === 0 ? (
        <Card>
          <Empty description="这张大盘还没有面板" />
        </Card>
      ) : (
        <Row gutter={[12, 12]}>
          {panels.map((p) => {
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
                  onDone={onPanelDone}
                  actions={
                    editing ? (
                      <Space size={2}>
                        <Button
                          size="small"
                          type="text"
                          icon={<EditOutlined />}
                          onClick={() => setEditingPanel(p)}
                        />
                        <Button
                          size="small"
                          type="text"
                          danger
                          icon={<DeleteOutlined />}
                          onClick={() => setDraft(panels.filter((x) => x.id !== p.id))}
                        />
                      </Space>
                    ) : null
                  }
                />
              </Col>
            );
          })}
        </Row>
      )}

      <PanelEditor
        open={!!editingPanel}
        panel={editingPanel}
        datasets={datasets}
        onClose={() => setEditingPanel(null)}
        onSubmit={(updated) => {
          setDraft(panels.map((x) => (x.id === updated.id ? updated : x)));
          setEditingPanel(null);
        }}
      />
    </div>
  );
}
