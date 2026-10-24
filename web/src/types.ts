export type StringMap = Record<string, string>;

// 数据源级访问控制。用对象而不是数组，后续可以往里加 users / roles 等维度。
// tenants 为空（或缺失）表示不限制，所有租户可见。
export interface ACL {
  tenants?: string[];
}

// 查询页看到的数据源：刻意不含 mid_sql，用户不感知 SQL。
export interface QueryDatasource {
  datasource_key: string;
  datasource_name: string;
  dim_map: StringMap;
  mtx_map: StringMap;
  label_map: StringMap;
  acl: ACL;
}

export interface DatasourceConfig {
  id: number;
  datasource_key: string;
  datasource_name: string;
  mid_sql: string;
  dim_map: StringMap;
  mtx_map: StringMap;
  label_map: StringMap;
  acl: ACL;
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
  label_map: StringMap;
  acl: ACL;
  status?: number;
}

// 过滤条件树：分组节点带 logic + children，叶子节点带 field/op/value。
// 分组可嵌套，用来表达 A AND (B OR C) 这类组合。
export interface FilterNode {
  logic?: 'and' | 'or';
  children?: FilterNode[];
  field?: string;
  op?: string;
  value?: string;
  values?: string[];
}

export interface OrderBy {
  field: string;
  desc: boolean;
}

// 查询意图：前端只描述想看什么，SQL 由后端生成，用户不感知 SQL 的存在。
export interface QueryRequest {
  datasource_key: string;
  dims: string[];
  metrics: string[];
  filter?: FilterNode;
  order_by: OrderBy[];
  limit: number;
}

export interface ResultColumn {
  name: string;
  type: string;
}

export interface QueryResult {
  columns: ResultColumn[];
  rows: unknown[][];
  row_count: number;
  elapsed_ms: number;
  truncated: boolean;
}

export interface UpdatePayload {
  datasource_name: string;
  mid_sql: string;
  dim_map: StringMap;
  mtx_map: StringMap;
  label_map: StringMap;
  acl: ACL;
  status?: number;
  version: number;
}
