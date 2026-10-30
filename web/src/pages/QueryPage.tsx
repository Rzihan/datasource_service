import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { App, Alert, Button, Card, Col, Drawer, Empty, List, Row, Space, Spin, Tooltip, Typography } from 'antd';
import { DeleteOutlined, HistoryOutlined, LinkOutlined } from '@ant-design/icons';
import QueryBuilder from '../components/QueryBuilder';
import ResultView from '../components/ResultView';
import { executeQuery, fetchDimValues, fetchQueryDatasets } from '../api';
import type { FilterNode, OrderBy, QueryDataset, QueryResult } from '../types';
import { emptyRoot, countLeaves, describeFilter, pruneEmpty } from '../utils/filterTree';
import { isAdditiveMetric } from '../utils/format';
import type { HistoryEntry } from '../utils/queryHistory';
import { clearHistory, historyTime, loadHistory, pushHistory } from '../utils/queryHistory';
import { subscribeTenants } from '../identity';

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
}

const MAX_LIMIT = 10000;

export default function QueryPage() {
  const { message } = App.useApp();
  const [searchParams, setSearchParams] = useSearchParams();
  const [datasets, setDatasets] = useState<QueryDataset[]>([]);
  const [loadingList, setLoadingList] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string>('');
  const [dims, setDims] = useState<string[]>([]);
  const [metrics, setMetrics] = useState<string[]>([]);
  const [filterTree, setFilterTree] = useState<FilterNode>(emptyRoot());
  const [orderBy, setOrderBy] = useState<OrderBy | null>(null);
  const [limit, setLimit] = useState(1000);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [querying, setQuerying] = useState(false);
  const [error, setError] = useState<string>('');
  const [dimValues, setDimValues] = useState<Record<string, string[]>>({});
  const [dimValueLoading, setDimValueLoading] = useState<Record<string, boolean>>({});
  const [history, setHistory] = useState<HistoryEntry[]>(loadHistory);
  const [historyOpen, setHistoryOpen] = useState(false);

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

  // 从 URL 恢复：链接是「可交付物」，同事点开应该看到同一张图，
  // 而不是一个空白的查询构建器。
  const applyUrlState = useCallback(
    (items: QueryDataset[]) => {
      const sp = new URLSearchParams(window.location.search);
      const key = sp.get('ds') ?? '';
      const ds = items.find((d) => d.dataset_key === key);
      if (!ds) return;

      // 链接可能来自别的环境/别人删过字段，只保留当前数据集真实存在的字段
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

      setSelectedKey(key);
      setDims(dims);
      setMetrics(metrics);
      setFilterTree(filter);
      setOrderBy(order);
      setLimit(safeLimit);
      if (dims.length > 0 || metrics.length > 0) {
        void execute({ key, dims, metrics, filterTree: filter, orderBy: order, limit: safeLimit });
      }
    },
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
    }
    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true });
    }
  }, [selectedKey, dims, metrics, filterTree, orderBy, limit, searchParams, setSearchParams]);

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
    setResult(null);
    setError('');
    setDimValues({});
  };

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
    void execute({ key: selectedKey, dims, metrics, filterTree, orderBy, limit });
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
    });
  };

  const labelOf = (datasetKey: string) => (field: string) => {
    const ds = datasets.find((d) => d.dataset_key === datasetKey);
    return ds?.label_map?.[field] || field;
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      message.success('链接已复制：对方打开即回到当前查询');
    } catch {
      message.warning('浏览器不允许自动复制，请手动复制地址栏链接');
    }
  };

  return (
    <Row gutter={16}>
      <Col xs={24} md={9} lg={8}>
        <Card
          size="small"
          title="查询构建器"
          extra={
            <Space size={0}>
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
            />
          )}
        </Card>
      </Col>
      <Col xs={24} md={15} lg={16}>
        <Card size="small" title="查询结果">
          {error && (
            <Alert
              type="error"
              showIcon
              style={{ marginBottom: 12 }}
              message="查询失败"
              description={error}
            />
          )}
          <ResultView
            result={result}
            dims={dims}
            metrics={metrics}
            nonAdditive={metrics.filter((m) => !isAdditiveMetric(selected?.mtx_map?.[m]))}
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
        </Card>
      </Col>

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
