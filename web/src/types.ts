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

// 预置分析：数据集作者把「这张表该怎么用」钉在看板上。
// query 就是查询页地址栏里 ds 之后的那一段，前端拼回 /query 即可还原。
export interface MetaExample {
  title: string;
  note?: string;
  query: string;
}

// 菜单入口：把这个数据集钉在某个存量页面的菜单位置上。
//
// 为什么需要它：历史用户要迁移的不是「查询能力」，而是「我原来那个页面」。
// 只给一个可视化查询页、让他在几十个数据集里认出哪个是原来那张表，
// 等于把识别成本转嫁给用户。入口挂在原位置，且是「数据集 + 固定视图」的组合。
export interface DatasetEntry {
  // 入口标识，进 URL（/e/{key}），只允许小写字母数字与短横线
  key: string;
  // 菜单标题，留空则用数据集名
  title?: string;
  // 所属模块（一级菜单名）
  module?: string;
  // 它替代的存量页面标识
  legacy?: string;
  // 迁移状态：parallel 并存 / default 默认走新版 / replaced 旧页已下线
  status?: 'parallel' | 'default' | 'replaced';
  // 与旧页的差异说明：换了什么口径、多了什么能力
  note?: string;
  // 入口自己的默认视图，优先于数据集的 default_example
  default_query?: string;
  sort?: number;
}

// 数据集说明书。不参与 SQL 生成，只影响「看不看得懂、敢不敢用」。
export interface DatasetMeta {
  description?: string;
  owner?: string;
  update_freq?: string;
  tags?: string[];
  // key 是 dim_map / mtx_map 的键，值是口径说明（单位、公式、注意事项）
  field_notes?: Record<string, string>;
  examples?: MetaExample[];
  // 作者的默认视图：某条 example 的 query。
  // 作者不该靠「堆十条预置」表达意图——那只是把选择成本转嫁给用户。
  default_example?: string;
  // 菜单挂载点。一个数据集最多挂一个入口——挂多个说明它本来就该拆开。
  entry?: DatasetEntry;
}

// 查询页看到的数据集：刻意不含 mid_sql（用户不感知 SQL）与 acl。
// dim_map / mtx_map 已按列级白名单过滤，看不到的列不会出现。
export interface QueryDataset {
  dataset_key: string;
  dataset_name: string;
  dim_map: StringMap;
  // 多值维度：出现在维度下拉里，但值是收拢后的（如「公司A,公司B」）。
  // 前端要把它合并进维度列表，并给用户一个「多值」标记。
  multi_dim_map: StringMap;
  mtx_map: StringMap;
  label_map: StringMap;
  meta: DatasetMeta;
}

export interface DatasetConfig {
  id: number;
  dataset_key: string;
  dataset_name: string;
  mid_sql: string;
  dim_map: StringMap;
  multi_dim_map: StringMap;
  mtx_map: StringMap;
  label_map: StringMap;
  acl: ACL;
  meta: DatasetMeta;
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
  multi_dim_map: StringMap;
  mtx_map: StringMap;
  label_map: StringMap;
  acl: ACL;
  meta?: DatasetMeta;
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

// 对比周期。prev_period = 上一个等长周期，prev_year = 去年同期。
export type CompareMode = 'prev_period' | 'prev_year';

export interface CompareRequest {
  mode: CompareMode;
  // 必须是普通日期维度（dim_map 的键）
  field: string;
}

// 后端算好的对比口径与上期值。上期值是按维度对齐后的一维数组，
// 与 rows 一一对应；上期独有的组合会被补成一行（本期指标为 null）。
export interface CompareMeta {
  mode: CompareMode;
  field: string;
  base_from: string;
  base_to: string;
  prev_from: string;
  prev_to: string;
  prev_values: Record<string, Array<unknown>>;
  added_rows: number;
  base_inferred: boolean;
  prev_truncated: boolean;
}

// 数据集体检报告：回答「这个数据集能不能信」——
// 多少行、覆盖到哪天、谁负责、多久更新一次。不在 dim_map 里，只能扫一遍数据才知道。
export interface DatasetStats {
  dataset_key: string;
  row_count: number;
  date_field?: string;
  min_date?: string;
  max_date?: string;
  cover_days: number;
  // max_date 距今多少天；负值说明数据里出现了未来日期
  lag_days: number;
  elapsed_ms: number;
  scanned_at: string;
  cached: boolean;
  // 扫描失败不连坐：只是这份报告没有，数据集照样能查
  error?: string;
  dim_count: number;
  multi_dim_count: number;
  metric_count: number;
  owner?: string;
  update_freq?: string;
  updated_at?: string;
  updated_by?: string;
  config_version: number;
}

// 查询意图：前端只描述想看什么，SQL 由后端生成，用户不感知 SQL 的存在。
export interface QueryRequest {
  dataset_key: string;
  dims: string[];
  metrics: string[];
  filter?: FilterNode;
  order_by: OrderBy[];
  limit: number;
  compare?: CompareRequest;
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
  compare?: CompareMeta;
}

export interface UpdatePayload {
  dataset_name: string;
  mid_sql: string;
  dim_map: StringMap;
  multi_dim_map: StringMap;
  mtx_map: StringMap;
  label_map: StringMap;
  acl: ACL;
  status?: number;
  version: number;
  // 不传 = 不动说明书（后端保留原值）。传了就整段替换：
  // 「没说」和「说没有」必须是两件事，所以是指针语义而不是默认值 {}
  meta?: DatasetMeta;
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

// 配置自检结果。失败时不走错误码：诊断信息装在 result 里更有用。
// stage 指出问题出在哪一步：template=模板语法 / mid=mid_sql 本身 /
// expr=dim_map / multi_dim_map / mtx_map 的表达式。
export interface DryRunResult {
  ok: boolean;
  stage?: string;
  error?: string;
  sql?: string;
  mid_columns: string[];
  columns: string[];
  checked_keys: string[];
  elapsed_ms: number;
}

// 多值维度误配扫描：一个字段看着像多值维度（底层是数组列 / 表达式用了数组函数），
// 却被配成了指标或普通维度。列出来供人确认，不自动改。
export interface MultiDimCandidate {
  dataset_key: string;
  field_key: string;
  from: 'mtx_map' | 'dim_map';
  expr: string;
  reason: string;
  // 建议搬进 multi_dim_map 的表达式（已剥掉收拢外壳）
  suggest_expr: string;
  // 能确认 suggest_expr 真的产出数组才为 true；false 时只提示、不给一键迁移
  confident: boolean;
}

export interface MultiDimCheckResult {
  candidates: MultiDimCandidate[];
  dataset_count: number;
  scanned: number;
}

export interface LabelCheckResult {
  conflicts: LabelConflict[];
  case_mismatch: LabelCaseMismatch[];
  missing: LabelMissing[];
  orphans: LabelOrphan[];
  dataset_count: number;
  global_count: number;
}
