import axios from 'axios';
import type {
  CreatePayload,
  DatasourceConfig,
  ListResult,
  QueryRequest,
  QueryResult,
  UpdatePayload,
} from './types';

const http = axios.create({ baseURL: '/api/v1', timeout: 20000 });

// 系统不接鉴权，操作人来自本地填写的用户名，随请求头带给后端记入 created_by / updated_by。
http.interceptors.request.use((config) => {
  config.headers['X-User'] = localStorage.getItem('ds_operator') || 'system';
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

export function executeQuery(payload: QueryRequest): Promise<QueryResult> {
  return unwrap(http.post('/query/execute', payload));
}

export function fetchDimValues(key: string, field: string): Promise<{ field: string; values: string[] }> {
  return unwrap(http.get(`/datasources/${encodeURIComponent(key)}/dim-values`, { params: { field } }));
}
