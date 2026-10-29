import type { FilterNode } from '../types';

// 分组节点的 logic 必填，用这个判断节点类型最省事
export const isGroup = (n: FilterNode): boolean => !!n.logic;

// 需要一组值（values）而不是单个值的操作符。
// 多值维度的 has_any / has_all 也属于这一类，别只写 in / not in。
export const MULTI_VALUE_OPS = ['in', 'not in', 'has_any', 'has_all'];

export const emptyRoot = (): FilterNode => ({ logic: 'and', children: [] });

// 叶子是否填了值。没填值的条件既没意义，也会让后端报无意义的错。
//
// MULTI_VALUE_OPS 必须是唯一来源：这里漏登记一个操作符，那条条件就会被
// pruneEmpty 静默丢掉——用户以为筛了，实际看到的是全量数据。
export const leafFilled = (n: FilterNode): boolean => {
  const op = n.op ?? '=';
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
