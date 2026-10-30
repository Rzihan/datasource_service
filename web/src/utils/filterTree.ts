import type { FilterNode } from '../types';

// 分组节点的 logic 必填，用这个判断节点类型最省事
export const isGroup = (n: FilterNode): boolean => !!n.logic;

// 需要一组值（values）而不是单个值的操作符。
// 多值维度的 has_any / has_all 也属于这一类，别只写 in / not in。
export const MULTI_VALUE_OPS = ['in', 'not in', 'has_any', 'has_all'];

// 不需要右值的操作符。它们必须被 leafFilled 认成「已填」——
// 否则 pruneEmpty 会把用户刚加的空值条件当成「没填值」静默裁掉，
// 界面看着筛了、实际查的是全量，比报错危险得多。
export const NULL_OPS = ['is_null', 'is_not_null'];

export const emptyRoot = (): FilterNode => ({ logic: 'and', children: [] });

// 叶子是否填了值。没填值的条件既没意义，也会让后端报无意义的错。
//
// MULTI_VALUE_OPS 必须是唯一来源：这里漏登记一个操作符，那条条件就会被
// pruneEmpty 静默丢掉——用户以为筛了，实际看到的是全量数据。
export const leafFilled = (n: FilterNode): boolean => {
  const op = n.op ?? '=';
  if (NULL_OPS.includes(op)) return true;
  if (MULTI_VALUE_OPS.includes(op)) {
    return (n.values?.length ?? 0) > 0;
  }
  return (n.value ?? '').trim() !== '';
};

// 剔除没填值的叶子，并丢掉因此变空的分组。
// 返回 null 表示整棵树都没内容。
export const pruneEmpty = (n: FilterNode): FilterNode | null => {
  if (isGroup(n)) {
    const kids = (n.children ?? [])
      .map(pruneEmpty)
      .filter((c): c is FilterNode => c !== null);
    return kids.length > 0 ? { ...n, children: kids } : null;
  }
  return leafFilled(n) ? n : null;
};

// 删掉引用了指定字段的叶子（用于取消勾选指标时联动清理），同样丢弃变空的分组。
// removed 会被塞进 collected，方便上层拿去拼提示文案。
export const removeFields = (
  n: FilterNode,
  fields: string[],
  collected: string[],
): FilterNode | null => {
  if (isGroup(n)) {
    const kids = (n.children ?? [])
      .map((c) => removeFields(c, fields, collected))
      .filter((c): c is FilterNode => c !== null);
    return kids.length > 0 ? { ...n, children: kids } : null;
  }
  if (n.field && fields.includes(n.field)) {
    collected.push(n.field);
    return null;
  }
  return n;
};

// 统计叶子数量，用于提示文案。
export const countLeaves = (n: FilterNode | null): number => {
  if (!n) return 0;
  if (!isGroup(n)) return 1;
  return (n.children ?? []).reduce((sum, c) => sum + countLeaves(c), 0);
};

// ---- 时间范围：前端只是两个 >= / <= 条件 ----
//
// 不引入新的后端算子，是因为区间本来就等于「>= 起 AND <= 止」。
// 用它拼条件树，能自动享受条件计数、清空、URL/历史序列化这些已有能力，
// 用户也能在条件区看到它到底加了什么，而不是一个藏在别处的隐形筛选。
const RANGE_OPS = ['>=', '<='];

export const collectLeaves = (n: FilterNode | null): FilterNode[] => {
  if (!n) return [];
  if (!isGroup(n)) return [n];
  return (n.children ?? []).flatMap(collectLeaves);
};

export function findRange(
  n: FilterNode | null,
  field: string,
): { from: string; to: string } | null {
  const leaves = collectLeaves(n).filter(
    (l) => l.field === field && l.op && RANGE_OPS.includes(l.op) && (l.value ?? '').trim() !== '',
  );
  const from = leaves.find((l) => l.op === '>=')?.value ?? '';
  const to = leaves.find((l) => l.op === '<=')?.value ?? '';
  return from || to ? { from, to } : null;
}

// 摘掉某字段上的区间条件；返回 null 表示整棵树空了
export function stripRange(n: FilterNode | null, field: string): FilterNode | null {
  if (!n) return null;
  if (!isGroup(n)) {
    return n.field === field && n.op && RANGE_OPS.includes(n.op) ? null : n;
  }
  const kids = (n.children ?? [])
    .map((c) => stripRange(c, field))
    .filter((c): c is FilterNode => c !== null);
  return kids.length > 0 ? { ...n, children: kids } : null;
}

// 覆盖式写入区间：同一字段永远只有一对 >= / <=，不会叠成「>= A AND >= B」。
// 根节点是 OR 时把原条件收进子分组，区间本身必须是 AND ——
// 直接把区间塞进 OR 会让「时间范围」变成「或」，那是另一个查询。
export function withRange(
  root: FilterNode,
  field: string,
  from: string,
  to: string,
): FilterNode {
  const leaves: FilterNode[] = [];
  if (from) leaves.push({ field, op: '>=', value: from });
  if (to) leaves.push({ field, op: '<=', value: to });
  if (leaves.length === 0) return stripRange(root, field) ?? emptyRoot();

  const base = stripRange(root, field);
  if (!base || (base.children ?? []).length === 0) return { logic: 'and', children: leaves };
  if (base.logic === 'or') return { logic: 'and', children: [{ ...base }, ...leaves] };
  return { ...base, children: [...(base.children ?? []), ...leaves] };
}

// 把条件树说成人话：历史记录、导出文件的口径说明都用它。
// 不用 JSON —— 没人愿意读 {"logic":"and","children":[...]}。
const OP_TEXT: Record<string, string> = {
  '=': '=',
  '!=': '≠',
  '>': '>',
  '>=': '≥',
  '<': '<',
  '<=': '≤',
  like: '包含',
  in: '属于',
  'not in': '不属于',
  has: '包含',
  has_not: '不包含',
  has_any: '包含任一',
  has_all: '包含全部',
};

export function describeFilter(n: FilterNode | null, labelOf: (f: string) => string): string {
  if (!n) return '';
  if (!isGroup(n)) {
    const field = labelOf(n.field ?? '');
    const op = n.op ?? '=';
    if (op === 'is_null') return `${field} 为空`;
    if (op === 'is_not_null') return `${field} 不为空`;
    const value = MULTI_VALUE_OPS.includes(op) ? (n.values ?? []).join('、') : (n.value ?? '');
    if (!value) return '';
    return `${field} ${OP_TEXT[op] ?? op} ${value}`;
  }
  const parts = (n.children ?? []).map((c) => describeFilter(c, labelOf)).filter(Boolean);
  const body = parts.join(n.logic === 'or' ? ' 或 ' : ' 且 ');
  return parts.length > 1 ? `(${body})` : body;
}
