export type StringMap = Record<string, string>;

export interface DatasourceConfig {
  id: number;
  datasource_key: string;
  datasource_name: string;
  mid_sql: string;
  dim_map: StringMap;
  mtx_map: StringMap;
  status: number;
  version: number;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export interface ListResult {
  items: DatasourceConfig[];
  total: number;
  page: number;
  size: number;
}

export interface CreatePayload {
  datasource_key: string;
  datasource_name: string;
  mid_sql: string;
  dim_map: StringMap;
  mtx_map: StringMap;
  status?: number;
}

export interface UpdatePayload {
  datasource_name: string;
  mid_sql: string;
  dim_map: StringMap;
  mtx_map: StringMap;
  status?: number;
  version: number;
}
