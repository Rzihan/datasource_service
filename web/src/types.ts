export type StringMap = Record<string, string>;

// 行级过滤规则：把登录态的某个身份集合，映射到数据集里的一个维度列，
// 查询时以「列 IN (...)」的形式追加到 WHERE。关闭 = 不追加。
// column 只能取 dim_map 的键：行级过滤发生在聚合前，指标是聚合结果，放不进 WHERE。
export interface RowRule {
  enabled: boolean;
  column?: string;
}

// 行级过滤整体开关。tenant 用登录态租户，user 用登录态可见用户。
// 例：{"tenant":{"enabled":true,"column":"tenant"},"user":{"enabled":true,"column":"owner"}}
export interface RowFilter {
  tenant?: RowRule;
  user?: RowRule;
}

// 数据集级访问控制。用对象而不是数组，后续可以往里加 roles 等维度。
//   tenants：数据集级白名单，空 = 不限制
//   col_tenants：列级白名单，key 是 dim_map / mtx_map 的键；没配的列默认可见
//   row_filter：行级过滤，按登录态租户 / 可见用户过滤数据行
// 示例：
// {"tenants":["t1","t2"],
//  "col_tenants":{"stat_date":["t1"],"cost":["t1","t2"]},
//  "row_filter":{"tenant":{"enabled":true,"column":"tenant"}}}
export interface ACL {
  tenants?: string[];
  col_tenants?: Record<string, string[]>;
  row_filter?: RowFilter;
}

// 查询页看到的数据集：刻意不含 mid_sql（用户不感知 SQL）与 acl。
// dim_map / mtx_map 已按列级白名单过滤，看不到的列不会出现。
export interface QueryDataset {
  dataset_key: string;
  dataset_name: string;
  dim_map: StringMap;
  mtx_map: StringMap;
  label_map: StringMap;
}

export interface DatasetConfig {
  id: number;
  dataset_key: string;
  dataset_name: string;
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
  items: DatasetConfig[];
  total: number;
  page: number;
  size: number;
}

export interface CreatePayload {
  dataset_key: string;
  dataset_name: string;
  mid_sql: string;
  dim_map: StringMap;
  mtx_map: StringMap;
  label_map: StringMap;
  acl: ACL;
  status?: number;
}

// 数据集配置的一次变更快照。snapshot 不返回给前端：mid_sql 最长 1 MiB，
// 列表里带全量快照会把响应撑爆，回滚只需要 id。
export interface DatasetHistory {
  id: number;
  dataset_key: string;
  version: number;
  action: 'create' | 'update' | 'delete' | 'rollback';
  operator: string;
  created_at: string;
}

export interface HistoryResult {
  items: DatasetHistory[];
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
  dataset_key: string;
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
  dataset_name: string;
  mid_sql: string;
  dim_map: StringMap;
  mtx_map: StringMap;
  label_map: StringMap;
  acl: ACL;
  status?: number;
  version: number;
}

// 全局字段名称定义：一份「字段名 → 中文名」的字典，对所有数据集生效。
// 数据集自己的 label_map 是覆盖层，优先级更高。
export interface GlobalLabel {
  id: number;
  field_key: string;
  label: string;
  status: number;
  version: number;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export interface LabelListResult {
  items: GlobalLabel[];
  total: number;
  page: number;
  size: number;
}

export interface LabelCreatePayload {
  field_key: string;
  label: string;
  status?: number;
}

// field_key 不可改：改名等价于删一条建一条，原地改会让引用它的数据集在不知情下换名字。
export interface LabelUpdatePayload {
  label: string;
  status?: number;
  version: number;
}

// 一致性检查的四类问题。都不会报错，只会让中文名静默不生效或显示错，
// 所以必须扫出来由人判断：哪些是真同名不同义，哪些是该同步而没同步。
export interface LabelOverride {
  dataset_key: string;
  label: string;
}

export interface LabelConflict {
  field_key: string;
  global_label: string;
  overrides: LabelOverride[];
}

// 数据集字段名与字典大小写不一致：`Cost` 永远匹配不上 `cost`，全局定义静默失效
export interface LabelCaseMismatch {
  dataset_key: string;
  field_key: string;
  global_key: string;
  global_label: string;
}

export interface LabelMissing {
  field_key: string;
  datasets: string[];
}

export interface LabelOrphan {
  field_key: string;
  label: string;
}

export interface LabelCheckResult {
  conflicts: LabelConflict[];
  case_mismatch: LabelCaseMismatch[];
  missing: LabelMissing[];
  orphans: LabelOrphan[];
  dataset_count: number;
  global_count: number;
}
