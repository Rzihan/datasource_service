import axios from 'axios';
import type {
  CreatePayload,
  DatasourceConfig,
  ListResult,
  QueryDatasource,
  QueryRequest,
  QueryResult,
  UpdatePayload,
} from './types';

const http = axios.create({ baseURL: '/api/v1', timeout: 20000 });

// 系统不接鉴权：操作人来自本地填写的用户名，租户 / 可见用户来自本地选择的列表，
// 三者都随请求头带给后端，分别用于审计、数据源级可见性与行级过滤。
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
  return unwrap(http.get('/datasources', { params }));
}

export function fetchOne(key: string): Promise<DatasourceConfig> {
  return unwrap(http.get(`/datasources/${encodeURIComponent(key)}`));
}

export function createDatasource(payload: CreatePayload): Promise<DatasourceConfig> {
  return unwrap(http.post('/datasources', payload));
}

export function updateDatasource(key: string, payload: UpdatePayload): Promise<DatasourceConfig> {
  return unwrap(http.put(`/datasources/${encodeURIComponent(key)}`, payload));
}

export function deleteDatasource(key: string): Promise<unknown> {
  return unwrap(http.delete(`/datasources/${encodeURIComponent(key)}`));
}

// 查询页的数据源列表：已按请求头里的租户过滤，且不含 mid_sql
export function fetchQueryDatasources(): Promise<{ items: QueryDatasource[] }> {
  return unwrap(http.get('/query/datasources'));
}

export function executeQuery(payload: QueryRequest): Promise<QueryResult> {
  return unwrap(http.post('/query/execute', payload));
}

export function fetchDimValues(key: string, field: string): Promise<{ field: string; values: string[] }> {
  return unwrap(http.get(`/datasources/${encodeURIComponent(key)}/dim-values`, { params: { field } }));
}
