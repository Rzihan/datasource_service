import { useCallback, useEffect, useMemo, useState } from 'react';
import { App, Alert, Card, Col, Row, Spin } from 'antd';
import QueryBuilder from '../components/QueryBuilder';
import ResultView from '../components/ResultView';
import { executeQuery, fetchDimValues, fetchQueryDatasources } from '../api';
import type { FilterNode, OrderBy, QueryDatasource, QueryResult } from '../types';
import { emptyRoot, pruneEmpty } from '../utils/filterTree';
import { subscribeTenants } from '../identity';

export default function QueryPage() {
  const { message } = App.useApp();
  const [datasources, setDatasources] = useState<QueryDatasource[]>([]);
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

  // 这里拿的是「按登录态租户过滤后」的数据源，所以看不到就说明没权限
  const loadDatasources = useCallback(async () => {
    setLoadingList(true);
    try {
      const res = await fetchQueryDatasources();
      setDatasources(res.items ?? []);
    } catch (e) {
      message.error((e as Error).message || '加载数据源失败');
    } finally {
      setLoadingList(false);
    }
  }, [message]);

  useEffect(() => {
    void loadDatasources();
    // 顶栏切换租户后要重新拉一次可见数据源
    return subscribeTenants(() => void loadDatasources());
  }, [loadDatasources]);

  const selected = useMemo(
    () => datasources.find((d) => d.datasource_key === selectedKey) ?? null,
    [datasources, selectedKey],
  );

  // 切换租户后当前数据源可能已不可见，这时要把选择清掉，避免拿着看不到的 key 去查
  useEffect(() => {
    if (selectedKey && datasources.length > 0 && !datasources.some((d) => d.datasource_key === selectedKey)) {
      setSelectedKey('');
      setDims([]);
      setMetrics([]);
      setFilterTree(emptyRoot());
      setOrderBy(null);
      setResult(null);
      setError('');
      setDimValues({});
    }
  }, [datasources, selectedKey]);

  // 切换数据源时重置选择：不同数据源的维度/指标完全不同，留着旧的只会报错。
  const onSelectDatasource = (key: string) => {
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

  const onExecute = async () => {
    if (!selectedKey) return;
    setQuerying(true);
    setError('');
    try {
      // 空值的条件不提交，避免后端报无意义的错
      const pruned = pruneEmpty(filterTree);
      const res = await executeQuery({
        datasource_key: selectedKey,
        dims,
        metrics,
        filter: pruned ?? undefined,
        order_by: orderBy ? [orderBy] : [],
        limit,
      });
      setResult(res);
    } catch (e) {
      setResult(null);
      setError((e as Error).message || '查询失败');
    } finally {
      setQuerying(false);
    }
  };

  return (
    <Row gutter={16}>
      <Col xs={24} md={8} lg={7}>
        <Card size="small" title="查询构建器">
          {loadingList ? (
            <Spin />
          ) : (
            <QueryBuilder
              datasources={datasources}
              selected={selected}
              onSelectDatasource={onSelectDatasource}
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
      <Col xs={24} md={16} lg={17}>
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
          <ResultView result={result} dims={dims} metrics={metrics} labelMap={selected?.label_map ?? {}} />
        </Card>
      </Col>
    </Row>
  );
}
