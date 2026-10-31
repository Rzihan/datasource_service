import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import dayjs from 'dayjs';
import {
  Alert,
  App as AntApp,
  Breadcrumb,
  Button,
  Card,
  Checkbox,
  Col,
  DatePicker,
  Empty,
  Modal,
  Row,
  Segmented,
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
  NodeIndexOutlined,
  PlusOutlined,
  ReloadOutlined,
  RightOutlined,
  RollbackOutlined,
  DownloadOutlined,
  ExportOutlined,
  LinkOutlined,
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
import { markOpened } from '../utils/dashboardPrefs';

// 一次「点图形下钻出来的整屏筛选」。它跟顶部声明的筛选器是两回事：
// 声明的是作者钉好的常用维度，这个是看的人临时追问「这个柱子是谁」。
interface CrossFilter {
  // 每步一个 id：下钻链要能「只删中间某一步」而不是按字段整片删
  id: string;
  field: string;
  value: string;
  from: string;
}

// 从 URL 还原整屏状态用：坏掉的参数一律当「没带」，别让一条手改过的链接打不开页面
function readJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
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
  const [params, setSearchParams] = useSearchParams();
  const [fromLegacy] = useState(() => params.get('from') === 'legacy');

  // 顶部筛选器的当前值。key 是字段名而不是下标：
  // 作者增删筛选器时，已选的值不该跟着错位。
  // 初值从 URL 还原（v8）：链接即快照，把当前这屏发给同事，对方打开看到同一套筛选。
  const [filterValues, setFilterValues] = useState<Record<string, string>>(() => {
    const f = readJson<Record<string, unknown>>(params.get('f'));
    if (!f || typeof f !== 'object') return {};
    return Object.fromEntries(
      Object.entries(f).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== ''),
    );
  });
  // 大盘级时间范围：分析师最常用的动作之一是「只看最近 7 天 / 这一段」。
  // ── 时间筛选：相对意图，而非冻结的绝对区间 ──────────────────────────
  // 看这类数据通常「以时间维度区分、每天点开看最近一段」。所以预设必须是
  // 「相对窗口」（近 7 天 = 到今天的近 7 天），每次取数/自动刷新都基于「今天」
  // 重算，才会每天自动滚动，而不是点一次就固定在某段日期上再也不变。
  // 模式记进 localStorage：相对窗口永远滚到今天；手动选的固定区间也保留；
  // 清空只清当次（不写存储），下次打开仍回到记住的模式（默认近 7 天）。
  type DateMode =
    | { kind: 'all' }
    | { kind: 'relative'; preset: 'today' | '7d' | '14d' | '30d' | 'month'; includeToday?: boolean }
    | { kind: 'custom'; start: string; end: string };

  const DATE_MODE_KEY = 'dashboard:dateMode';
  const defaultDateMode = (): DateMode => {
    try {
      const raw = localStorage.getItem(DATE_MODE_KEY);
      if (raw) {
        const m = JSON.parse(raw) as DateMode;
        if (m && (m.kind === 'all' || m.kind === 'relative' || m.kind === 'custom')) return m;
      }
    } catch {
      /* 存储坏了就回退默认 */
    }
    return { kind: 'relative', preset: '7d' };
  };
  const [dateMode, setDateMode] = useState<DateMode>(() => {
    // URL 里的时间模式最优先：分享链接时，「我看到的时间窗口」要原样跟过去。
    // 相对窗口存的是预设名，对方打开时基于他的「今天」重算——跟 v6 的滚动语义一致。
    const m = readJson<DateMode>(params.get('dm'));
    if (m && (m.kind === 'all' || m.kind === 'relative' || m.kind === 'custom')) return m;
    return defaultDateMode();
  });
  // 滚动窗口依赖「今天」：自动刷新时一起往前走，开着页面数据也滑动。
  const [now, setNow] = useState<dayjs.Dayjs>(() => dayjs());

  // 由模式 + 今天算出实际绝对窗口。relative 每次基于 now 重算 → 永远滚动到今天。
  // includeToday=false 时窗口止于昨天：今天的数据往往只到当前时刻，是不完整的，
  // 拿它算环比会把「较昨日」拉低成噪声——要看完整天的人可以关掉它。
  const resolveWindow = (mode: DateMode, base: dayjs.Dayjs): [string, string] | null => {
    if (mode.kind === 'all') return null;
    if (mode.kind === 'custom') return [mode.start, mode.end];
    const includeToday = mode.includeToday ?? true;
    const end = includeToday ? base : base.subtract(1, 'day');
    let start: dayjs.Dayjs;
    switch (mode.preset) {
      case 'today': start = base.startOf('day'); break;
      case '7d': start = end.subtract(6, 'day'); break;
      case '14d': start = end.subtract(13, 'day'); break;
      case '30d': start = end.subtract(29, 'day'); break;
      case 'month': start = end.startOf('month'); break;
    }
    return [start.format('YYYY-MM-DD'), end.format('YYYY-MM-DD')];
  };
  // 应用一个模式：persist=true 写进 localStorage（记住选择）；清空类操作传 false（仅当次）。
  const applyMode = (mode: DateMode, persist: boolean) => {
    setDateMode(mode);
    if (persist) {
      try {
        localStorage.setItem(DATE_MODE_KEY, JSON.stringify(mode));
      } catch {
        /* 忽略写入失败 */
      }
    }
  };
  const dateWindow = resolveWindow(dateMode, now); // 供 extraFor / note 复用，随 now 滚动
  const PRESET_LABEL: Record<string, string> = {
    today: '今日', '7d': '近 7 天', '14d': '近 14 天', '30d': '近 30 天', month: '本月',
  };
  // 相对窗口的名字：关掉「含今天」时把口径说出来，免得「近 7 天」和面板日期对不上
  const relativeName = (m: Extract<DateMode, { kind: 'relative' }>) =>
    PRESET_LABEL[m.preset] + (m.preset !== 'today' && !(m.includeToday ?? true) ? '（到昨天）' : '');
  const [crossFilters, setCrossFilters] = useState<CrossFilter[]>(() => {
    const x = readJson<Array<{ field?: unknown; value?: unknown; from?: unknown }>>(params.get('x'));
    if (!Array.isArray(x)) return [];
    return x
      .filter((c) => c && typeof c.field === 'string' && typeof c.value === 'string')
      .map((c) => ({
        id: `${String(c.field)}:${String(c.value)}:url`,
        field: String(c.field),
        value: String(c.value),
        from: typeof c.from === 'string' ? c.from : '链接',
      }));
  });
  const [options, setOptions] = useState<Record<string, string[]>>({});

  // 布局密度：舒适（默认）与紧凑两档。紧凑档收窄卡片间距与内边距，
  // 一屏能多看几块；舒适档留白多，单块读着不挤。
  const [density, setDensity] = useState<'cozy' | 'compact'>('cozy');
  // 放大：把某一块单独弹大看清。点「放大这一块」时记下它的面板与当前整屏筛选，
  // 弹层里用放大后的高度重画同一份数据，并给一个跳去查询页深链。
  const [focus, setFocus] = useState<{ panel: DashboardPanel; extra: FilterNode | null; note?: string } | null>(null);

  // 整屏状态写回 URL（v8）：筛选值、下钻链、时间模式。
  // 用 replace：改一个筛选就多一条历史，返回键会变成撤销键（与查询页同一约定）。
  // 相对时间窗口只存预设名不存绝对日期——对方打开时基于他的「今天」重算，才会同样滚动。
  useEffect(() => {
    const next = new URLSearchParams();
    if (Object.values(filterValues).some(Boolean)) next.set('f', JSON.stringify(filterValues));
    if (crossFilters.length > 0) {
      next.set(
        'x',
        JSON.stringify(crossFilters.map((c) => ({ field: c.field, value: c.value, from: c.from }))),
      );
    }
    next.set('dm', JSON.stringify(dateMode));
    setSearchParams(next, { replace: true });
  }, [filterValues, crossFilters, dateMode, setSearchParams]);

  // 把当前这屏（连同筛选状态）发给同事。状态已经在 URL 里，
  // 这里只是把地址栏交到用户手上——「复制链接」不该让人手动框选地址栏。
  const shareLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      message.success('链接已复制：对方打开即回到当前这屏（筛选、下钻、时间窗口都会跟过去）');
    } catch {
      message.warning('浏览器不允许自动复制，请手动复制地址栏链接');
    }
  };

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
      setNow(dayjs()); // 滚动窗口随刷新往前滑
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

  // 记一笔个人使用痕迹（v9）：仪表盘列表拿它做「最近打开」与常用排序。
  // 记在本地——这是我自己的查看习惯，不该写进后端变成别人的配置。
  useEffect(() => {
    if (dashKey) markOpened(dashKey);
  }, [dashKey]);

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
      // 时间范围：拆成两个边界条件，落在 date 维度上。
      // 有 date 维度的面板才加，否则那个面板会被一个不存在的字段筛成空。
      // 用的是「基于今天的滚动窗口」——相对预设每次都重新算到今天。
      if (dateWindow && hasField(ds, 'date')) {
        leaves.push({ field: 'date', op: '>=', value: dateWindow[0] });
        leaves.push({ field: 'date', op: '<=', value: dateWindow[1] });
      }
      if (leaves.length === 0) return null;
      return { logic: 'and', children: leaves };
    },
    [byKey, dashboard, filterValues, crossFilters, dateWindow, now],
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
    // 同一个字段再点一次是「改这一层的取值」，就地替换、保持它在链上的位置，
    // 而不是把它挪到队尾——否则下钻路径的顺序会被一次重复点击打乱。
    setCrossFilters((prev) => {
      const i = prev.findIndex((c) => c.field === field);
      if (i >= 0) {
        const next = [...prev];
        next[i] = { ...next[i], value: x, from: panel.title || panel.id };
        return next;
      }
      return [...prev, { id: `${field}:${x}:${Date.now()}`, field, value: x, from: panel.title || panel.id }];
    });
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
      const parts = [
        // 相对窗口在口径里写「近 7 天（10-25~10-31）」：既说明是滚动意图，也留下当时实际窗口
        ...(dateWindow
          ? [
              dateMode.kind === 'relative'
                ? `${relativeName(dateMode)}（${dateWindow[0]}~${dateWindow[1]}）`
                : `日期 ${dateWindow[0]}~${dateWindow[1]}`,
            ]
          : []),
        ...filters.filter((f) => filterValues[f.field]).map((f) => `${f.label || f.field}=${filterValues[f.field]}`),
        ...crossFilters.map((c) => `${c.field}=${c.value}`),
      ];
      chunks.push(`# 整屏筛选 ${parts.join('、')}`);
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
    // BOM + \r\n：不带这两样，Excel 直接双击打开就是乱码/挤一列；
    // 查询页的导出早就有，整屏导出没跟上，这里对齐。
    const blob = new Blob(['\uFEFF' + chunks.join('\r\n')], { type: 'text/csv;charset=utf-8' });
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
  const activeCount =
    Object.values(filterValues).filter(Boolean).length + crossFilters.length + (dateMode.kind !== 'all' ? 1 : 0);
  // 有没有「带 date 维度的面板」决定要不要露时间范围控件：
  // 一屏全是按团队/场景汇总、没有时间轴的，给个日期选择器只会让人白点。
  const hasDatePanel = panels.some((p) => {
    const d = byKey.get(p.dataset);
    return !!d && 'date' in d.dim_map;
  });

  // 下钻字段的中文名：优先用顶部声明筛选器里的 label，没有就原样显示字段名
  const labelOf = (field: string) => filters.find((f) => f.field === field)?.label || field;
  const removeCross = (id: string) => setCrossFilters((prev) => prev.filter((c) => c.id !== id));
  const undoCross = () => setCrossFilters((prev) => prev.slice(0, -1));
  const clearAllFilters = () => {
    setFilterValues({});
    setCrossFilters([]);
    // 清空只作用于当次：不写 localStorage，下次打开仍回到记住的时间模式（默认近 7 天）。
    applyMode({ kind: 'all' }, false);
  };

  // 把某一块「原样搬到查询页」：用与面板同一份查询串还原出查询页的 URL，
  // 并把当前整屏筛选一起带过去（作为 filter JSON）。用户在大盘里看到异常的那块，
  // 下一步往往是「去查询页换个维度继续挖」，这个链接省掉他重新搭一遍的功夫。
  const openInQuery = (panel: DashboardPanel, extra: FilterNode | null): string => {
    const ds = byKey.get(panel.dataset);
    if (!ds) return '/query';
    const it = parseIntent(ds, panelQuery(ds, panel.query));
    const q = new URLSearchParams();
    q.set('ds', ds.dataset_key);
    if (it.dims.length) q.set('dims', it.dims.join(','));
    if (it.metrics.length) q.set('metrics', it.metrics.join(','));
    if (it.orderBy) {
      q.set('order', it.orderBy.field);
      q.set('dir', it.orderBy.desc ? 'desc' : 'asc');
    }
    q.set('limit', String(it.limit));
    if (extra) q.set('filter', JSON.stringify(extra));
    return `/query?${q.toString()}`;
  };

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
          <Button size="small" icon={<LinkOutlined />} onClick={shareLink}>
            复制链接
          </Button>
          <Segmented
            size="small"
            value={density}
            onChange={(v) => setDensity(v as 'cozy' | 'compact')}
            options={[
              { label: '舒适', value: 'cozy' },
              { label: '紧凑', value: 'compact' },
            ]}
          />
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
      {(filters.length > 0 || crossFilters.length > 0 || hasDatePanel) && (
        <Card size="small" style={{ marginBottom: 12 }} styles={{ body: { padding: '8px 12px' } }}>
          <Space size={8} wrap align="center">
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              <FilterOutlined /> 整屏筛选
            </Typography.Text>
            {hasDatePanel && (
              // 时间模式直接露在筛选项里：选中的是「相对窗口」还是「自定义固定区间」一眼可见。
              // 相对窗口（近 7 天等）每次取数都基于今天重算——每天打开、每次刷新都会滚到最新。
              <Segmented
                size="small"
                value={
                  dateMode.kind === 'relative'
                    ? dateMode.preset
                    : dateMode.kind === 'custom'
                      ? '__custom__'
                      : '__all__'
                }
                onChange={(v) => {
                  const val = String(v);
                  if (val === '__all__') {
                    applyMode({ kind: 'all' }, false);
                  } else if (val === '__custom__') {
                    // 进入自定义：先给一个「近 7 天」的绝对区间作起点，用户再改
                    const end = dayjs();
                    applyMode(
                      { kind: 'custom', start: end.subtract(6, 'day').format('YYYY-MM-DD'), end: end.format('YYYY-MM-DD') },
                      true,
                    );
                  } else {
                    // 切预设时保留「含今天」的开关状态——那是同一个完整天偏好，不随预设重置
                    applyMode(
                      {
                        kind: 'relative',
                        preset: val as 'today' | '7d' | '14d' | '30d' | 'month',
                        includeToday: dateMode.kind === 'relative' ? (dateMode.includeToday ?? true) : true,
                      },
                      true,
                    );
                  }
                }}
                options={[
                  { label: '全部', value: '__all__' },
                  { label: '今日', value: 'today' },
                  { label: '近 7 天', value: '7d' },
                  { label: '近 14 天', value: '14d' },
                  { label: '近 30 天', value: '30d' },
                  { label: '本月', value: 'month' },
                  { label: '自定义', value: '__custom__' },
                ]}
              />
            )}
            {hasDatePanel && dateMode.kind === 'relative' && dateMode.preset !== 'today' && (
              // 「含今天」默认开：大多数时候想连今天一起看。
              // 但今天的数据只到当前时刻，是不完整的——拿它算环比会被拉低。
              // 要完整天的人关掉它，窗口改为止于昨天，跨预设切换时这个偏好保留。
              <Tooltip title="今天的数据往往只到当前时刻，是不完整的。关掉后按「到昨天」的完整天计算，环比不会被半截数据拉低">
                <Checkbox
                  checked={dateMode.includeToday ?? true}
                  onChange={(e) => applyMode({ ...dateMode, includeToday: e.target.checked }, true)}
                  style={{ fontSize: 12 }}
                >
                  含今天
                </Checkbox>
              </Tooltip>
            )}
            {hasDatePanel && dateMode.kind === 'custom' && (
              <DatePicker.RangePicker
                size="small"
                style={{ width: 210 }}
                value={[dayjs(dateMode.start), dayjs(dateMode.end)]}
                format="MM-DD"
                allowClear
                placeholder={['开始', '结束']}
                onChange={(v) =>
                  v && v[0] && v[1]
                    ? applyMode(
                        { kind: 'custom', start: v[0].format('YYYY-MM-DD'), end: v[1].format('YYYY-MM-DD') },
                        true,
                      )
                    : applyMode({ kind: 'all' }, false)
                }
              />
            )}
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
            {activeCount > 0 && (
              <Button size="small" type="link" onClick={clearAllFilters}>
                清空筛选
              </Button>
            )}
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {activeCount > 0
                ? `${followCount} 个面板跟随${noFollowCount > 0 ? `、${noFollowCount} 个不跟随` : ''}`
                : '点面板里的图形可以把它下钻成整屏筛选'}
            </Typography.Text>
          </Space>
          {crossFilters.length > 0 && (
            // 下钻链：把「点了哪几根柱子」按顺序留下来，而不是一堆并列的标签。
            // 断点由「返回上一层」回到上一步，单步的 × 只撤这一步。
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                flexWrap: 'wrap',
                marginTop: 8,
                paddingTop: 8,
                borderTop: '1px dashed #f0f0f0',
              }}
            >
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                <NodeIndexOutlined /> 下钻链
              </Typography.Text>
              {crossFilters.map((c, i) => (
                <Fragment key={c.id}>
                  {i > 0 && <RightOutlined style={{ fontSize: 10, color: '#bfbfbf' }} />}
                  <Tag closable color="blue" style={{ marginInlineEnd: 0 }} onClose={() => removeCross(c.id)}>
                    <Tooltip title={`第 ${i + 1} 步 · 来自面板「${c.from}」`}>
                      <span>
                        {labelOf(c.field)} = {c.value}
                      </span>
                    </Tooltip>
                  </Tag>
                </Fragment>
              ))}
              <Button size="small" type="link" icon={<RollbackOutlined />} onClick={undoCross}>
                返回上一层
              </Button>
            </div>
          )}
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
        <Row gutter={density === 'compact' ? [8, 8] : [12, 12]}>
          {panels.map((p) => {
            const extra = extraFor(p);
            const note = extra
              ? [
                  ...(dateWindow ? [`日期 ${dateWindow[0]}~${dateWindow[1]}`] : []),
                  ...filters.filter((f) => filterValues[f.field]).map((f) => `${f.label || f.field}=${filterValues[f.field]}`),
                  ...crossFilters.map((c) => `${labelOf(c.field)}=${c.value}`),
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
                  dense={density === 'compact'}
                  onFocus={() => setFocus({ panel: p, extra, note })}
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

      <Modal
        open={!!focus}
        title={focus ? focus.panel.title || '面板' : ''}
        width={920}
        onCancel={() => setFocus(null)}
        footer={
          focus
            ? [
                <Button key="close" onClick={() => setFocus(null)}>
                  关闭
                </Button>,
                <Link key="open" to={openInQuery(focus.panel, focus.extra)}>
                  <Button type="primary" icon={<ExportOutlined />}>
                    在查询页打开
                  </Button>
                </Link>,
              ]
            : null
        }
        styles={{ body: { padding: 12 } }}
      >
        {focus && (
          <DashboardPanelCard
            panel={{ ...focus.panel, height: 460 }}
            dataset={byKey.get(focus.panel.dataset)}
            extraFilter={focus.extra}
            filterNote={focus.note}
            noFollow={focus.panel.follow === false}
          />
        )}
      </Modal>
    </div>
  );
}
