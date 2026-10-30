import axios from 'axios';
import type {
  CreatePayload,
  DatasetConfig,
  DatasetStats,
  DryRunResult,
  GlobalLabel,
  HistoryResult,
  LabelCheckResult,
  LabelCreatePayload,
  LabelListResult,
  LabelUpdatePayload,
  ListResult,
  MultiDimCheckResult,
  QueryDataset,
  QueryRequest,
  QueryResult,
  StringMap,
  UpdatePayload,
} from './types';

const http = axios.create({ baseURL: '/api/v1', timeout: 20000 });

// 系统不接鉴权：操作人来自本地填写的用户名，租户 / 可见用户来自本地选择的列表，
// 三者都随请求头带给后端，分别用于审计、数据集级可见性与行级过滤。
// 注意这几个头由服务端读取，客户端传什么就按什么过滤——真实环境必须由网关覆盖。
http.interceptors.request.use((config) => {
  config.headers['X-User'] = localStorage.getItem('ds_operator') || 'system';
  config.headers['X-Tenants'] = localStorage.getItem('ds_tenants') || '';
  config.headers['X-Visible-Users'] = localStorage.getItem('ds_visible_users') || '';
  return config;
});

// 把后端的统一响应结构拆开：code 非 0 时直接抛错，业务侧只处理 data。
async function unwrap<T>(promise: Promise<{ data: { code: number; message: string; data: T } }>): Promise<T> {
  const res = await promise.catch((err: unknown) => {
    const e = err as { response?: { data?: { message?: string } }; message?: string };
    throw new Error(e.response?.data?.message || e.message || '请求失败');
  });
  if (res.data.code !== 0) {
    throw new Error(res.data.message || '请求失败');
  }
  return res.data.data;
}

export function fetchList(params: { page: number; size: number; keyword?: string }): Promise<ListResult> {
  return unwrap(http.get('/datasets', { params }));
}

export function fetchOne(key: string): Promise<DatasetConfig> {
  return unwrap(http.get(`/datasets/${encodeURIComponent(key)}`));
}

export function createDataset(payload: CreatePayload): Promise<DatasetConfig> {
  return unwrap(http.post('/datasets', payload));
}

export function updateDataset(key: string, payload: UpdatePayload): Promise<DatasetConfig> {
  return unwrap(http.put(`/datasets/${encodeURIComponent(key)}`, payload));
}

export function deleteDataset(key: string): Promise<unknown> {
  return unwrap(http.delete(`/datasets/${encodeURIComponent(key)}`));
}

// 查询页的数据集列表：已按请求头里的租户过滤，且不含 mid_sql
// 配置自检：拿真实数仓跑一遍待保存的配置，不需要先保存
export function dryRunDataset(payload: {
  mid_sql: string;
  dim_map: StringMap;
  multi_dim_map: StringMap;
  mtx_map: StringMap;
}): Promise<DryRunResult> {
  return unwrap(http.post('/datasets/dry-run', payload));
}

export function fetchHistories(key: string, limit = 50): Promise<HistoryResult> {
  return unwrap(http.get(`/datasets/${encodeURIComponent(key)}/histories`, { params: { limit } }));
}

// 回滚本身也会记一条历史，所以回滚可以再被回滚。
export function rollbackDataset(key: string, historyId: number): Promise<DatasetConfig> {
  return unwrap(http.post(`/datasets/${encodeURIComponent(key)}/rollback`, { history_id: historyId }));
}

export function fetchQueryDatasets(): Promise<{ items: QueryDataset[] }> {
  return unwrap(http.get('/query/datasets'));
}

export function executeQuery(payload: QueryRequest): Promise<QueryResult> {
  return unwrap(http.post('/query/execute', payload));
}

export function fetchDimValues(key: string, field: string): Promise<{ field: string; values: string[] }> {
  return unwrap(http.get(`/datasets/${encodeURIComponent(key)}/dim-values`, { params: { field } }));
}

// 数据集体检报告。扫全表计数，后端缓存 10 分钟；失败时返回带 error 的报告，
// 不抛错——查数不该因为「体检报告没做出来」就不能用。
export function fetchDatasetStats(key: string): Promise<DatasetStats> {
  return unwrap(http.get(`/datasets/${encodeURIComponent(key)}/stats`));
}

// 多值维度误配扫描：把「疑似多值维度却当指标/普通维度配着」的列出来
export function fetchMultiDimCheck(): Promise<MultiDimCheckResult> {
  return unwrap(http.get('/multi-dim-check'));
}

// 把字段搬进 multi_dim_map。带乐观锁：扫描到点迁移之间别人可能改过配置。
// expr 由调用方把扫描建议带回——服务端拿不到 mid_sql 的列类型，不做猜测。
export function migrateMultiDim(
  key: string,
  payload: { items: Array<{ field: string; expr: string }>; version: number },
): Promise<DatasetConfig> {
  return unwrap(http.post(`/datasets/${encodeURIComponent(key)}/migrate-multi-dim`, payload));
}

export function fetchLabelList(params: {
  page: number;
  size: number;
  keyword?: string;
}): Promise<LabelListResult> {
  return unwrap(http.get('/labels', { params }));
}

// 全量字典。数据集编辑页用它显示「继承：XXX」提示，因此不走分页。
export function fetchLabelMap(): Promise<{ label_map: StringMap }> {
  return unwrap(http.get('/label-map'));
}

export function createLabel(payload: LabelCreatePayload): Promise<GlobalLabel> {
  return unwrap(http.post('/labels', payload));
}

export function updateLabel(key: string, payload: LabelUpdatePayload): Promise<GlobalLabel> {
  return unwrap(http.put(`/labels/${encodeURIComponent(key)}`, payload));
}

export function deleteLabel(key: string): Promise<unknown> {
  return unwrap(http.delete(`/labels/${encodeURIComponent(key)}`));
}

// 一致性检查：冲突 / 大小写不生效 / 缺失 / 孤儿
export function fetchLabelCheck(): Promise<LabelCheckResult> {
  return unwrap(http.get('/label-check'));
}
