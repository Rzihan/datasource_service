import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  App,
  Button,
  Card,
  Checkbox,
  Col,
  Drawer,
  Empty,
  Input,
  List,
  Modal,
  Row,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  DeleteOutlined,
  HistoryOutlined,
  LinkOutlined,
  StarFilled,
  StarOutlined,
} from '@ant-design/icons';
import QueryBuilder from '../components/QueryBuilder';
import ResultView from '../components/ResultView';
import FavoritesDrawer from '../components/FavoritesDrawer';
import DiagnosisPanel from '../components/DiagnosisPanel';
import { executeQuery, fetchDatasetStats, fetchDimValues, fetchQueryDatasets } from '../api';
import type {
  CompareRequest,
  DatasetStats,
  FilterNode,
  OrderBy,
  QueryDataset,
  QueryResult,
} from '../types';
import {
  addCondition,
  countLeaves,
  describeFilter,
  emptyRoot,
  hasCondition,
  pruneEmpty,
  removeCondition,
  removeLeafByText,
} from '../utils/filterTree';
import { isAdditiveMetric } from '../utils/format';
import type { FixAction } from '../utils/diagnose';
import { diagnoseEmpty, diagnoseError } from '../utils/diagnose';
import type { HistoryEntry } from '../utils/queryHistory';
import { clearHistory, historyTime, loadHistory, pushHistory } from '../utils/queryHistory';
import type { FavoriteEntry } from '../utils/favorites';
import {
  clearFavorites,
  favoriteSignature,
  loadFavorites,
  removeFavorite,
  renameFavorite,
  saveFavorite,
  setDefaultFavorite,
  togglePinFavorite,
} from '../utils/favorites';
import { subscribeTenants } from '../identity';
import { setPrefs, usePrefs } from '../utils/prefs';

// 一次查询的完整输入。抽成对象是为了两件事：
//   1. 从 URL 恢复时要拿「刚解析出来的值」直接查，不能等 setState 生效；
//   2. 查询历史回填时要能一次性替换掉全部条件。
interface QueryIntent {
  key: string;
  dims: string[];
  metrics: string[];
  filterTree: FilterNode;
  orderBy: OrderBy | null;
  limit: number;
  compare: CompareRequest | null;
}

const MAX_LIMIT = 10000;

export default function QueryPage() {
  const { message } = App.useApp();
  // 界面档位是全局偏好：切到简洁档后，口径说明、推荐提示、预置分析都收起来
  const prefs = usePrefs();
  const compact = prefs.density === 'compact';
  const [searchParams, setSearchParams] = useSearchParams();
  const [datasets, setDatasets] = useState<QueryDataset[]>([]);
  const [loadingList, setLoadingList] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string>('');
  const [dims, setDims] = useState<string[]>([]);
  const [metrics, setMetrics] = useState<string[]>([]);
  const [filterTree, setFilterTree] = useState<FilterNode>(emptyRoot());
  const [orderBy, setOrderBy] = useState<OrderBy | null>(null);
  const [limit, setLimit] = useState(1000);
  // 对比周期：开不开是一回事，「跟哪个日期维度比」是另一回事，
  // 两者一起进 URL 才能把一张带环比的图发给同事。
  const [compare, setCompare] = useState<CompareRequest | null>(null);
  // 下钻路径：只记「点出来的」那几条，渲染时再与条件树对一遍——
  // 用户在条件区手动删掉某条后，面包屑不该还挂在那里。
  const [drills, setDrills] = useState<Array<{ field: string; value: string }>>([]);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [querying, setQuerying] = useState(false);
  const [error, setError] = useState<string>('');
  const [dimValues, setDimValues] = useState<Record<string, string[]>>({});
  const [dimValueLoading, setDimValueLoading] = useState<Record<string, boolean>>({});
  const [history, setHistory] = useState<HistoryEntry[]>(loadHistory);
  const [historyOpen, setHistoryOpen] = useState(false);
  // 收藏：和历史分开存。历史是滚动的「刚才查过什么」，收藏是有名字的「每周都要看一次」。
  const [favorites, setFavorites] = useState<FavoriteEntry[]>(loadFavorites);
  const [favOpen, setFavOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saveNote, setSaveNote] = useState('');
  const [saveAsDefault, setSaveAsDefault] = useState(false);
  // 数据集体检报告：选完数据集就异步扫一次，不阻塞查询
  const [stats, setStats] = useState<DatasetStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);

  // URL 只在「首次加载完数据集」时读一次：之后 URL 由下面那个同步 effect 单向写，
  // 免得读改写互相触发，把用户的输入抖掉。
  const restoredRef = useRef(false);

  const execute = useCallback(
    async (intent: QueryIntent) => {
      setQuerying(true);
      setError('');
      try {
        // 空值的条件不提交，避免后端报无意义的错
        const pruned = pruneEmpty(intent.filterTree);
        // 保险：pruneEmpty 会静默丢掉「没填值」的条件。如果以后新增了用 values
        // 的操作符却忘了登记，用户会以为筛过了、实际拿到全量数据——那比报错危险。
        // 这里对比前后叶子数，丢了就明说。
        const dropped = countLeaves(intent.filterTree) - countLeaves(pruned);
        if (dropped > 0) {
          message.warning(`有 ${dropped} 个过滤条件没填值，本次查询已忽略`);
        }
        const res = await executeQuery({
          dataset_key: intent.key,
          dims: intent.dims,
          metrics: intent.metrics,
          filter: pruned ?? undefined,
          order_by: intent.orderBy ? [intent.orderBy] : [],
          limit: intent.limit,
          compare: intent.compare ?? undefined,
        });
        setResult(res);
        // 历史是「查过什么」的记录，只在成功后写：失败的那次没有参考价值
        setHistory(
          pushHistory({
            datasetKey: intent.key,
            dims: intent.dims,
            metrics: intent.metrics,
            filterTree: pruned ?? emptyRoot(),
            orderBy: intent.orderBy,
            limit: intent.limit,
            rows: res.row_count,
            elapsedMs: res.elapsed_ms,
          }),
        );
      } catch (e) {
        setResult(null);
        setError((e as Error).message || '查询失败');
      } finally {
        setQuerying(false);
      }
    },
    [message],
  );

  // 把一段查询串解析成一次查询意图。URL 与「作者预置的分析」共用这一份解析：
  // 预置存的就是 URL 里 ds 之后的那一段，只要链接能还原，预置就一定能还原，
  // 不需要维护两套规则，也不会出现「链接能开、预置开不了」。
  const parseIntent = (ds: QueryDataset, sp: URLSearchParams): QueryIntent => {
    // 查询串可能来自别的环境 / 数据集改过字段，只保留当前数据集真实存在的字段
    const parseList = (name: string, allowed: (f: string) => boolean) =>
      (sp.get(name) ?? '').split(',').filter((v) => v && allowed(v));

    const dims = parseList('dims', (f) => f in ds.dim_map || f in ds.multi_dim_map);
    const metrics = parseList('metrics', (f) => f in ds.mtx_map);

    let filter: FilterNode = emptyRoot();
    const rawFilter = sp.get('filter');
    if (rawFilter) {
      try {
        filter = JSON.parse(rawFilter) as FilterNode;
      } catch {
        filter = emptyRoot();
      }
    }
    const orderField = sp.get('order') ?? '';
    const order: OrderBy | null = orderField ? { field: orderField, desc: sp.get('dir') !== 'asc' } : null;
    const parsedLimit = Number(sp.get('limit') ?? 1000) || 1000;
    const safeLimit = Math.min(Math.max(parsedLimit, 1), MAX_LIMIT);
    const cmpMode = sp.get('cmp');
    const cmpField = sp.get('cmpf') ?? '';
    const cmp: CompareRequest | null =
      (cmpMode === 'prev_period' || cmpMode === 'prev_year') && cmpField in ds.dim_map
        ? { mode: cmpMode, field: cmpField }
        : null;
    return { key: ds.dataset_key, dims, metrics, filterTree: filter, orderBy: order, limit: safeLimit, compare: cmp };
  };

  // 一次落全量状态再查：不能让用户「先选数据集、再看预置里少了什么」。
  // 预置里带了 filter / 对比周期也一样，点一下就该是作者当时看到的那张图。
  const applyIntent = (ds: QueryDataset, sp: URLSearchParams) => {
    const it = parseIntent(ds, sp);
    setSelectedKey(it.key);
    setDims(it.dims);
    setMetrics(it.metrics);
    setFilterTree(it.filterTree);
    setOrderBy(it.orderBy);
    setLimit(it.limit);
    setCompare(it.compare);
    setDrills([]);
    setError('');
    if (it.dims.length > 0 || it.metrics.length > 0) {
      void execute(it);
    }
  };

  // 从 URL 恢复：链接是「可交付物」，同事点开应该看到同一张图，
  // 而不是一个空白的查询构建器。
  const applyUrlState = useCallback(
    (items: QueryDataset[]) => {
      const sp = new URLSearchParams(window.location.search);
      const key = sp.get('ds') ?? '';
      const ds = items.find((d) => d.dataset_key === key);
      if (!ds) return;
      const intent = parseIntent(ds, sp);
      // 链接里写明了要看什么就以链接为准；只给了数据集（或什么都没有）时，
      // 用我自己的默认视图——分享出去的链接必须能还原，这是更强的约定。
      if (intent.dims.length === 0 && intent.metrics.length === 0) {
        const fav = loadFavorites().find((f) => f.datasetKey === key && f.isDefault);
        if (fav) {
          applyFavorite(fav, items);
          return;
        }
      }
      applyIntent(ds, sp);
    },
    // applyIntent 每次渲染都是新的（它读的是当前状态），这里只依赖 execute：
    // 恢复只发生在「首次加载完数据集」那一次，不需要精确依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [execute],
  );

  // 这里拿的是「按登录态租户过滤后」的数据集，所以看不到就说明没权限
  const loadDatasets = useCallback(async () => {
    setLoadingList(true);
    try {
      const res = await fetchQueryDatasets();
      const items = res.items ?? [];
      setDatasets(items);
      if (!restoredRef.current) {
        restoredRef.current = true;
        applyUrlState(items);
      }
    } catch (e) {
      message.error((e as Error).message || '加载数据集失败');
    } finally {
      setLoadingList(false);
    }
  }, [message, applyUrlState]);

  useEffect(() => {
    void loadDatasets();
    // 顶栏切换租户后要重新拉一次可见数据集
    return subscribeTenants(() => void loadDatasets());
  }, [loadDatasets]);

  // 状态单向写回 URL：刷新 / 收藏 / 发给同事都回到同一屏。
  // 用 replace，避免每改一个下拉就多一条浏览器历史，返回键变成撤销键。
  useEffect(() => {
    if (!restoredRef.current) return;
    const next = new URLSearchParams();
    if (selectedKey) {
      next.set('ds', selectedKey);
      if (dims.length > 0) next.set('dims', dims.join(','));
      if (metrics.length > 0) next.set('metrics', metrics.join(','));
      const pruned = pruneEmpty(filterTree);
      if (pruned) next.set('filter', JSON.stringify(pruned));
      if (orderBy) {
        next.set('order', orderBy.field);
        next.set('dir', orderBy.desc ? 'desc' : 'asc');
      }
      next.set('limit', String(limit));
      if (compare) {
        next.set('cmp', compare.mode);
        next.set('cmpf', compare.field);
      }
    }
    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true });
    }
  }, [selectedKey, dims, metrics, filterTree, orderBy, limit, compare, searchParams, setSearchParams]);

  const selected = useMemo(
    () => datasets.find((d) => d.dataset_key === selectedKey) ?? null,
    [datasets, selectedKey],
  );

  // 切换租户后当前数据集可能已不可见，这时要把选择清掉，避免拿着看不到的 key 去查
  useEffect(() => {
    if (selectedKey && datasets.length > 0 && !datasets.some((d) => d.dataset_key === selectedKey)) {
      setSelectedKey('');
      setDims([]);
      setMetrics([]);
      setFilterTree(emptyRoot());
      setOrderBy(null);
      setCompare(null);
      setResult(null);
      setError('');
      setDimValues({});
    }
  }, [datasets, selectedKey]);

  // 切换数据集时重置选择：不同数据集的维度/指标完全不同，留着旧的只会报错。
  const onSelectDataset = (key: string) => {
    setSelectedKey(key);
    setDims([]);
    setMetrics([]);
    setFilterTree(emptyRoot());
    setOrderBy(null);
    setCompare(null);
    setDrills([]);
    setResult(null);
    setError('');
    setDimValues({});
    // 有默认视图就直接跑：作者的建议挂在数据集上（预置分析），
    // 我自己的分析也应该能挂上去（默认视图），而且优先级更高。
    openDatasetWithDefault(key);
  };

  // 数据集的规模与新鲜度：选完就扫，切换就换。
  // 单独一个请求而不是塞进数据集列表——列表要快，扫全表要慢，混在一起会把下拉拖住。
  const loadStats = useCallback(
    (key: string) => {
      if (!key) {
        setStats(null);
        return;
      }
      setStatsLoading(true);
      fetchDatasetStats(key)
        .then(setStats)
        .catch((e: Error) => setStats({ dataset_key: key, row_count: 0, cover_days: 0, lag_days: 0, elapsed_ms: 0, scanned_at: '', cached: false, dim_count: 0, multi_dim_count: 0, metric_count: 0, config_version: 0, error: e.message }))
        .finally(() => setStatsLoading(false));
    },
    [],
  );

  useEffect(() => {
    loadStats(selectedKey);
  }, [selectedKey, loadStats]);

  const onRequestDimValues = useCallback(
    (field: string) => {
      if (!selectedKey || dimValues[field] || dimValueLoading[field]) return;
      setDimValueLoading((prev) => ({ ...prev, [field]: true }));
      fetchDimValues(selectedKey, field)
        .then((res) => {
          setDimValues((prev) => ({ ...prev, [field]: res.values ?? [] }));
        })
        .catch(() => {
          // 取不到候选值不阻塞查询，退化成手填输入框
          setDimValues((prev) => ({ ...prev, [field]: [] }));
        })
        .finally(() => {
          setDimValueLoading((prev) => ({ ...prev, [field]: false }));
        });
    },
    [selectedKey, dimValues, dimValueLoading],
  );

  // 用当前界面状态查数
  const onExecute = () => {
    if (!selectedKey) return;
    void execute({ key: selectedKey, dims, metrics, filterTree, orderBy, limit, compare });
  };

  // 从结果页放宽返回上限：点了「放宽到 5000」就得带着新上限重查一次，
  // 否则按钮只是把左边输入框改了，用户还得自己再点一次查数。
  const setLimitAndQuery = (next: number) => {
    setLimit(next);
    if (!selectedKey) return;
    void execute({ key: selectedKey, dims, metrics, filterTree, orderBy, limit: next, compare });
  };

  // 下钻：把一个维度取值变成 `= 值` 条件。
  // 写进条件树而不是另存一份，是为了让「界面看着筛了」和「实际筛了」永远是同一件事。
  const drillInto = (field: string, value: string) => {
    if (!selectedKey) return;
    const next = addCondition(pruneEmpty(filterTree) ?? emptyRoot(), { field, op: '=', value });
    setFilterTree(next);
    setDrills((prev) => [...prev.filter((d) => !(d.field === field && d.value === value)), { field, value }]);
    void execute({ key: selectedKey, dims, metrics, filterTree: next, orderBy, limit, compare });
  };

  const undoDrill = (field: string, value: string) => {
    const next = removeCondition(pruneEmpty(filterTree), field, value) ?? emptyRoot();
    setFilterTree(next);
    setDrills((prev) => prev.filter((d) => !(d.field === field && d.value === value)));
    if (selectedKey) {
      void execute({ key: selectedKey, dims, metrics, filterTree: next, orderBy, limit, compare });
    }
  };

  // 历史回填：一次性替换全部条件再查，而不是让用户自己回忆当时筛了什么
  const restoreHistory = (entry: HistoryEntry) => {
    const ds = datasets.find((d) => d.dataset_key === entry.datasetKey);
    if (!ds) {
      message.warning('该数据集已不可见或已删除，无法回填');
      return;
    }
    setSelectedKey(entry.datasetKey);
    setDims(entry.dims);
    setMetrics(entry.metrics);
    setFilterTree(entry.filterTree);
    setOrderBy(entry.orderBy ?? null);
    setLimit(entry.limit);
    setHistoryOpen(false);
    void execute({
      key: entry.datasetKey,
      dims: entry.dims,
      metrics: entry.metrics,
      filterTree: entry.filterTree,
      orderBy: entry.orderBy ?? null,
      limit: entry.limit,
      compare,
    });
  };

  // 诊断面板给出的「一键修复」：每一条都对应一个具体的状态改动 + 立刻重查，
  // 不给「知道了」这种关掉就消失的按钮——那等于把问题还给用户。
  const applyFix = (action: FixAction) => {
    if (!selectedKey) return;
    const run = (patch: Partial<Pick<QueryIntent, 'dims' | 'metrics' | 'filterTree' | 'limit'>>) => {
      const next = { dims, metrics, filterTree, orderBy, limit, ...patch };
      void execute({
        key: selectedKey,
        dims: next.dims,
        metrics: next.metrics,
        filterTree: next.filterTree,
        orderBy,
        limit: next.limit,
        compare,
      });
    };
    switch (action.kind) {
      case 'clearFilter':
        setFilterTree(emptyRoot());
        setDrills([]);
        run({ filterTree: emptyRoot() });
        break;
      case 'dropFilter': {
        const next = removeLeafByText(pruneEmpty(filterTree), action.field, action.value) ?? emptyRoot();
        setFilterTree(next);
        setDrills((prev) => prev.filter((d) => !(d.field === action.field && d.value === action.value)));
        run({ filterTree: next });
        break;
      }
      case 'lowerLimit':
        setLimit(action.limit);
        run({ limit: action.limit });
        break;
      case 'clearDims':
        setDims([]);
        run({ dims: [] });
        break;
      case 'clearMetrics':
        setMetrics([]);
        run({ metrics: [] });
        break;
      case 'reloadDatasets':
        void loadDatasets();
        break;
    }
  };

  const labelOf = (datasetKey: string) => (field: string) => {
    const ds = datasets.find((d) => d.dataset_key === datasetKey);
    return ds?.label_map?.[field] || field;
  };

  // ── 收藏 ────────────────────────────────────────────────────────────
  // 收藏存的是「一屏查询的完整输入」，不是一条 URL。
  // 存输入的原因：数据集字段可能改名，打开时按当前字段重新校验一遍，
  // 比存一条会 404 的链接稳；而且收藏列表里要能显示「按什么维度、什么指标」。
  const openPreset = (query: string) => {
    if (!selected) return;
    applyIntent(selected, new URLSearchParams(query));
  };

  const currentSnapshot = () => ({
    datasetKey: selectedKey,
    dims,
    metrics,
    filterTree: pruneEmpty(filterTree) ?? emptyRoot(),
    orderBy,
    limit,
    compare,
  });

  const currentSig = favoriteSignature(currentSnapshot());
  const currentFavorite = favorites.find((f) => favoriteSignature(f) === currentSig);
  // 这个数据集的默认视图：打开数据集时会自动跑它，所以要让用户看得见、能取消
  const defaultFav = favorites.find((f) => f.datasetKey === selectedKey && f.isDefault);

  // 默认名：数据集 + 维度 + 指标。用户多半会改，但有个能用的起点比空着强——
  // 空着的话收藏夹里会躺一堆「未命名」。
  const suggestedName = () => {
    const dsName = selected?.dataset_name ?? selectedKey;
    const dimText = dims.map((d) => labelOf(selectedKey)(d)).join('、');
    const mtxText = metrics.map((m) => labelOf(selectedKey)(m)).join('、');
    const filterText = describeFilter(pruneEmpty(filterTree), labelOf(selectedKey));
    return [dsName, dimText && `按${dimText}`, mtxText, compare && (compare.mode === 'prev_year' ? '同比' : '环比')]
      .filter(Boolean)
      .join(' · ')
      .concat(filterText ? `（${filterText}）` : '')
      .slice(0, 40);
  };

  const openSaveModal = () => {
    if (!selectedKey) return;
    setSaveName(suggestedName());
    setSaveNote('');
    // 这个数据集还没有默认视图时，默认勾上：第一次收藏多半就是「我以后就按这个看」
    setSaveAsDefault(!loadFavorites().some((f) => f.datasetKey === selectedKey && f.isDefault));
    setSaveOpen(true);
  };

  const doSave = () => {
    const name = saveName.trim() || suggestedName();
    setFavorites(
      saveFavorite({
        ...currentSnapshot(),
        name,
        note: saveNote.trim() || undefined,
        isDefault: saveAsDefault,
      }),
    );
    setSaveOpen(false);
    message.success(saveAsDefault ? `已收藏「${name}」，并设为该数据集的默认视图` : `已收藏「${name}」`);
  };

  // 应用一条收藏：打开、置为默认视图后自动跑，都走这里。
  // 分出一个不带「关抽屉」的版本，是为了让默认视图在页面加载时也能复用同一套动作。
  // items 可以显式传入：首次加载时数据集列表刚取回来、还没进 state，
  // 直接用 state 会拿到空数组，导致默认视图静默不生效。
  const applyFavorite = (f: FavoriteEntry, items?: QueryDataset[]) => {
    const ds = (items ?? datasets).find((d) => d.dataset_key === f.datasetKey);
    if (!ds) return false;
    setSelectedKey(f.datasetKey);
    setDims(f.dims);
    setMetrics(f.metrics);
    setFilterTree(f.filterTree);
    setOrderBy(f.orderBy ?? null);
    setLimit(f.limit);
    setCompare(f.compare ?? null);
    setDrills([]);
    void execute({
      key: f.datasetKey,
      dims: f.dims,
      metrics: f.metrics,
      filterTree: f.filterTree,
      orderBy: f.orderBy ?? null,
      limit: f.limit,
      compare: f.compare ?? null,
    });
    return true;
  };

  const openFavorite = (f: FavoriteEntry) => {
    if (!applyFavorite(f)) {
      message.warning('该数据集已不可见或已删除，无法打开');
      return;
    }
    setFavOpen(false);
  };

  // 打开数据集时自动跑默认视图。
  // URL 里带了 dims/metrics 就以链接为准——分享出去的链接必须能还原，
  // 这是比「我想看默认视图」更强的约定。
  const defaultFavoriteFor = (key: string): FavoriteEntry | undefined =>
    loadFavorites().find((f) => f.datasetKey === key && f.isDefault);

  const openDatasetWithDefault = (key: string, items?: QueryDataset[]) => {
    const fav = defaultFavoriteFor(key);
    if (fav) applyFavorite(fav, items);
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      message.success('链接已复制：对方打开即回到当前查询');
    } catch {
      message.warning('浏览器不允许自动复制，请手动复制地址栏链接');
    }
  };

  // 只保留条件树里仍然存在的下钻条件，避免「条件已删、面包屑还在」
  const drillPath = drills.filter((d) => hasCondition(pruneEmpty(filterTree), d.field, d.value));

  return (
    <Row gutter={16}>
      <Col xs={24} md={9} lg={8}>
        <Card
          size="small"
          title="查询构建器"
          extra={
            <Space size={0}>
              <Tooltip title={currentFavorite ? `已收藏：${currentFavorite.name}` : '把当前这一屏存成名字，下次一点就回来'}>
                <Button
                  size="small"
                  type="text"
                  icon={currentFavorite ? <StarFilled style={{ color: '#faad14' }} /> : <StarOutlined />}
                  disabled={!selectedKey}
                  onClick={openSaveModal}
                >
                  {currentFavorite ? '已收藏' : '收藏'}
                </Button>
              </Tooltip>
              <Tooltip title="打开收藏夹">
                <Button size="small" type="text" onClick={() => setFavOpen(true)}>
                  收藏夹{favorites.length > 0 ? ` ${favorites.length}` : ''}
                </Button>
              </Tooltip>
              <Tooltip title="最近的查询，可一键回填">
                <Button
                  size="small"
                  type="text"
                  icon={<HistoryOutlined />}
                  onClick={() => setHistoryOpen(true)}
                >
                  历史
                </Button>
              </Tooltip>
              <Button
                size="small"
                type="text"
                icon={<LinkOutlined />}
                disabled={!selectedKey}
                onClick={copyLink}
              >
                复制链接
              </Button>
            </Space>
          }
        >
          {loadingList ? (
            <Spin />
          ) : (
            <QueryBuilder
              datasets={datasets}
              selected={selected}
              onSelectDataset={onSelectDataset}
              dims={dims}
              metrics={metrics}
              onDimsChange={setDims}
              onMetricsChange={setMetrics}
              filterTree={filterTree}
              onFilterTreeChange={setFilterTree}
              orderBy={orderBy}
              onOrderByChange={setOrderBy}
              limit={limit}
              onLimitChange={setLimit}
              dimValues={dimValues}
              dimValueLoading={dimValueLoading}
              onRequestDimValues={onRequestDimValues}
              onExecute={onExecute}
              loading={querying}
              compare={compare}
              onCompareChange={setCompare}
              stats={stats}
              statsLoading={statsLoading}
              onReloadStats={() => loadStats(selectedKey)}
              onOpenPreset={openPreset}
              compact={compact}
            />
          )}
        </Card>
      </Col>
      <Col xs={24} md={15} lg={16}>
        <Card size="small" title="查询结果">
          {error && (
            <div style={{ marginBottom: 12 }}>
              <DiagnosisPanel
                tone="error"
                busy={querying}
                diagnosis={diagnoseError(error, {
                  dataset: selected,
                  dims,
                  metrics,
                  filterTree,
                  labelOf: labelOf(selectedKey),
                  limit,
                })}
                onFix={applyFix}
              />
            </div>
          )}
          {/* 0 行不是「没有结果」，是「有一个原因」。表格里一句「暂无数据」
              把问题原样还给用户，这里改成诊断 + 一键放宽。 */}
          {!error && result && result.rows.length === 0 && (
            <div style={{ marginBottom: 12 }}>
              <DiagnosisPanel
                tone="empty"
                busy={querying}
                diagnosis={diagnoseEmpty({
                  dataset: selected,
                  dims,
                  metrics,
                  filterTree,
                  labelOf: labelOf(selectedKey),
                  limit,
                  elapsedMs: result.elapsed_ms,
                })}
                onFix={applyFix}
              />
            </div>
          )}
          {drillPath.length > 0 && (
            <Space size={6} wrap style={{ marginBottom: 10 }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                下钻路径
              </Typography.Text>
              {drillPath.map((d) => (
                <Tag
                  key={`${d.field}=${d.value}`}
                  color="geekblue"
                  closable
                  onClose={(e) => {
                    e.preventDefault();
                    undoDrill(d.field, d.value);
                  }}
                >
                  {labelOf(selectedKey)(d.field)} = {d.value}
                </Tag>
              ))}
              <Button
                type="link"
                size="small"
                onClick={() => {
                  let next = pruneEmpty(filterTree);
                  drillPath.forEach((d) => {
                    next = removeCondition(next, d.field, d.value);
                  });
                  setFilterTree(next ?? emptyRoot());
                  setDrills([]);
                  if (selectedKey) {
                    void execute({
                      key: selectedKey,
                      dims,
                      metrics,
                      filterTree: next ?? emptyRoot(),
                      orderBy,
                      limit,
                      compare,
                    });
                  }
                }}
              >
                返回上一层以上
              </Button>
            </Space>
          )}
          {defaultFav && (
            <Space size={6} style={{ marginBottom: 10 }}>
              <Tag color="gold">默认视图：{defaultFav.name}</Tag>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                打开这个数据集会自动跑这条
              </Typography.Text>
              <Button
                type="link"
                size="small"
                onClick={() => setFavorites(setDefaultFavorite(defaultFav.id, false))}
              >
                取消默认
              </Button>
            </Space>
          )}
          {/* 0 行时只留上面的诊断：再摆一张空表和 0 值指标卡，只是把同一句话抄三遍 */}
          {!(result && result.rows.length === 0) && (
          <ResultView
            result={result}
            dims={dims}
            metrics={metrics}
            nonAdditive={metrics.filter((m) => !isAdditiveMetric(selected?.mtx_map?.[m]))}
            limit={limit}
            onLimitChange={setLimitAndQuery}
            onDrill={drillInto}
            compact={compact}
            tableDense={prefs.tableDense ?? compact}
            onTableDenseChange={(v) => setPrefs({ tableDense: v })}
            emptyHint={
              !compact && (selected?.meta?.examples?.length ?? 0) > 0
                ? `或直接从左侧「作者预置的分析」里挑一个（${selected?.meta?.examples?.length} 个）`
                : undefined
            }
            labelMap={selected?.label_map ?? {}}
            exportMeta={{
              dataset: selected ? `${selected.dataset_key} · ${selected.dataset_name}` : selectedKey,
              dims: dims.map((d) => labelOf(selectedKey)(d)),
              metrics: metrics.map((m) => labelOf(selectedKey)(m)),
              filterText: describeFilter(pruneEmpty(filterTree), labelOf(selectedKey)),
              orderText: orderBy
                ? `${labelOf(selectedKey)(orderBy.field)} ${orderBy.desc ? '降序' : '升序'}`
                : '默认（第一个指标降序）',
              limit,
            }}
          />
          )}
        </Card>
      </Col>

      <FavoritesDrawer
        open={favOpen}
        onClose={() => setFavOpen(false)}
        favorites={favorites}
        datasets={datasets}
        activeId={currentFavorite?.id}
        canSave={!!selectedKey}
        onSaveCurrent={openSaveModal}
        onOpen={openFavorite}
        onSetDefault={(id, on) => {
          setFavorites(setDefaultFavorite(id, on));
          message.success(on ? '已设为默认视图：打开数据集会直接跑这条' : '已取消默认视图');
        }}
        onTogglePin={(id) => setFavorites(togglePinFavorite(id))}
        onRename={(id, name, note) => {
          setFavorites(renameFavorite(id, { name, note: note || undefined }));
          message.success('已更新');
        }}
        onDelete={(id) => setFavorites(removeFavorite(id))}
        onClear={() => {
          setFavorites(clearFavorites());
          message.success('收藏已清空');
        }}
      />

      <Modal
        title="收藏当前查询"
        open={saveOpen}
        onOk={doSave}
        onCancel={() => setSaveOpen(false)}
        okText="收藏"
        cancelText="取消"
        destroyOnHidden
      >
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          <Input
            placeholder="给它起个名字"
            value={saveName}
            maxLength={40}
            onChange={(e) => setSaveName(e.target.value)}
          />
          <Input.TextArea
            placeholder="备注：这张图用来看什么、什么时候看（可留空）"
            value={saveNote}
            rows={3}
            maxLength={120}
            onChange={(e) => setSaveNote(e.target.value)}
          />
          <Checkbox
            checked={saveAsDefault}
            onChange={(e) => setSaveAsDefault(e.target.checked)}
            style={{ fontSize: 13 }}
          >
            设为该数据集的默认视图（以后打开数据集直接跑这条）
          </Checkbox>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            存的是「数据集 + 维度 + 指标 + 筛选 + 排序 + 对比周期」这一整套，打开时按当前字段重新校验。
          </Typography.Text>
        </Space>
      </Modal>

      <Drawer
        title="查询历史"
        width={460}
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        extra={
          history.length > 0 && (
            <Button size="small" icon={<DeleteOutlined />} onClick={() => setHistory(clearHistory())}>
              清空
            </Button>
          )
        }
      >
        {history.length === 0 ? (
          <Empty description="还没有查询记录" />
        ) : (
          <List
            size="small"
            dataSource={history}
            renderItem={(e) => {
              const ds = datasets.find((d) => d.dataset_key === e.datasetKey);
              const dimsText = e.dims.length > 0 ? e.dims.map((d) => labelOf(e.datasetKey)(d)).join('、') : '无维度';
              const mtxText = e.metrics.length > 0 ? e.metrics.map((m) => labelOf(e.datasetKey)(m)).join('、') : '无指标';
              const filterText = describeFilter(e.filterTree, labelOf(e.datasetKey));
              return (
                <List.Item
                  actions={[
                    <Button key="fill" size="small" type="link" onClick={() => restoreHistory(e)}>
                      回填
                    </Button>,
                  ]}
                >
                  <List.Item.Meta
                    title={`${ds?.dataset_name ?? e.datasetKey} · ${dimsText} × ${mtxText}`}
                    description={
                      <div style={{ fontSize: 12 }}>
                        {filterText && <div>筛选：{filterText}</div>}
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {historyTime(e.ts)} · {e.rows} 行 · {e.elapsedMs} ms
                        </Typography.Text>
                      </div>
                    }
                  />
                </List.Item>
              );
            }}
          />
        )}
      </Drawer>
    </Row>
  );
}
