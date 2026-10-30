import type { FilterNode, QueryDataset } from '../types';
import { describeFilter, pruneEmpty } from './filterTree';

// 报错和空结果的处理原则：**先说人话，再给按钮**。
// 后端已经会返回中文错误，但那是给写 SQL 的人看的（「过滤字段 xx 不在 dim_map 中」）。
// 看到这句话的人多半只是想查个数，他需要的是「你这条筛选项数据集里已经没有了」+ 一个「去掉它」的按钮。

export type FixAction =
  // 清空全部筛选条件重查：条件太多时最快的一刀
  | { kind: 'clearFilter'; label: string }
  // 只去掉某一条：用户往往知道是哪一条筛狠了
  | { kind: 'dropFilter'; field: string; value: string; label: string }
  | { kind: 'lowerLimit'; limit: number; label: string }
  | { kind: 'clearDims'; label: string }
  | { kind: 'clearMetrics'; label: string }
  // 数据集字段变了：重新拉一次数据集列表，让下拉回到真实字段
  | { kind: 'reloadDatasets'; label: string };

export interface Diagnosis {
  // 一句话结论，能直接念出来
  title: string;
  // 解释「为什么」，以及这件事归谁
  detail?: string;
  // 可能的原因，逐条列；不确定的用「可能」
  reasons: string[];
  actions: FixAction[];
  // 原始错误：折叠起来，给要排查的人看，不挡着普通人
  raw?: string;
}

export interface DiagnoseCtx {
  dataset: QueryDataset | null;
  dims: string[];
  metrics: string[];
  filterTree: FilterNode;
  labelOf: (field: string) => string;
  limit: number;
}

const has = (s: string, ...keys: string[]) => keys.some((k) => s.includes(k));

// ── 报错 ──────────────────────────────────────────────────────────────
export function diagnoseError(err: string, ctx: DiagnoseCtx): Diagnosis {
  const raw = err;
  const e = err.toLowerCase();
  const owner = ctx.dataset?.meta?.owner;

  // 权限：跟用户说什么都改不了，只能说清是谁在拦
  if (has(err, '无权访问', 'forbidden')) {
    return {
      title: '当前登录态看不到这个数据集（或其中的某些列）',
      detail: '数据集配置了租户白名单 / 列级白名单，不是查询条件写错了。',
      reasons: [
        '在顶栏切换租户后重试，或让管理员把你所在租户加进白名单',
        owner ? `数据集负责人：${owner}` : '数据集没写负责人，可在配置页补上',
      ],
      actions: [],
      raw,
    };
  }

  // 字段对不上：数据集改过字段，或这条链接来自旧版本
  if (has(err, '不在该数据集的', '必须是已选择的维度或指标', '未被勾选', '不是该数据集的维度')) {
    return {
      title: '有一个字段这个数据集里已经没有了',
      detail: '数据集的字段被改过（删字段 / 改名），而当前查询还留着旧的维度、指标或筛选项。',
      reasons: [
        '重新拉一次数据集列表，按现在的字段重选一次',
        '如果这是别人发的链接，说明链接发出后数据集改过',
      ],
      actions: [
        { kind: 'reloadDatasets', label: '刷新数据集字段' },
        { kind: 'clearFilter', label: '清空筛选条件' },
      ],
      raw,
    };
  }

  // 条件写得太复杂：这是产品规则，得用产品语言解释
  if (has(err, 'OR 条件算不出来', 'AND 条件算不出来', '只能用 and / or', '嵌套超过', '条件超过')) {
    return {
      title: '这组筛选条件组合不出来',
      detail: '筛选里混用了「聚合前判断」（未勾选的维度）和「聚合后判断」（指标）的条件，二者不能放在同一个 OR 里。',
      reasons: [
        '把未勾选的维度先勾上，它就能下压到聚合前',
        '或者把这条指标条件挪到 AND 分组下，别放在 OR 里',
      ],
      actions: [{ kind: 'clearFilter', label: '清空筛选条件重来' }],
      raw,
    };
  }

  // 条件没填完整：这不是「没数据」，是「没填」
  if (has(err, '需要提供 values', '需要提供 value', '值为空', '缺少 field', '不支持的操作符', '只能用 has')) {
    return {
      title: '有一条筛选条件没填完整',
      detail: '条件框里的值没填或填的类型不对，本次查询没有执行。',
      reasons: ['逐条检查筛选条件，值不能为空', '多值维度（带标签）只能用「包含 / 不包含」类操作符'],
      actions: [{ kind: 'clearFilter', label: '清空筛选条件' }],
      raw,
    };
  }

  if (has(err, '至少需要选择一个维度或一个指标')) {
    return {
      title: '还没选要查什么',
      detail: '维度（按什么分组）和指标（看什么数）至少要选一个。',
      reasons: ['在左侧「维度」里勾一个分组字段，或在「指标」里勾一个数值字段'],
      actions: [],
      raw,
    };
  }

  if (has(err, '对比周期需要至少一个指标')) {
    return {
      title: '开了对比周期，但没选指标',
      detail: '只有维度、没有指标时，没有可对比的数值。',
      reasons: ['勾上至少一个指标，或把「对比周期」关掉'],
      actions: [],
      raw,
    };
  }

  // 执行层：超时 / 连不上 / 被打断
  if (has(e, 'timeout', 'i/o timeout', 'deadline', '超时', 'context canceled', 'eof', 'connection refused', 'connect: ', 'no such host', 'network')) {
    const heavy = ctx.dims.length >= 3 || ctx.limit >= 5000;
    return {
      title: '查询超时或没连上数仓',
      detail: '这一查太重了，或者数仓现在连不上。',
      reasons: [
        ctx.dims.length >= 3 ? `维度选了 ${ctx.dims.length} 个，分组组合会指数级膨胀` : '减少维度数量能显著降低耗时',
        ctx.limit >= 5000 ? `当前上限 ${ctx.limit} 行，先降到 1000 看看有没有数据` : '先加一条时间筛选缩小范围',
        '如果一直在转，可能是数仓连接不可用，需要看服务日志',
      ],
      actions: [
        ...(heavy ? [{ kind: 'lowerLimit' as const, limit: 1000, label: '把上限降到 1000 再查' }] : []),
        ...(ctx.dims.length > 1 ? [{ kind: 'clearDims' as const, label: '去掉维度，先看总数' }] : []),
        { kind: 'clearFilter', label: '清空筛选条件' },
      ],
      raw,
    };
  }

  // 落到数仓的语法/执行错误：这是数据集作者的问题，不是用户的问题
  if (has(e, 'code:', 'syntax error', 'unknown', 'not_an_aggregate', 'ambiguous', 'illegal', 'memory limit', 'too many', 'clickhouse')) {
    return {
      title: '数仓执行这条查询时报错了',
      detail: '不是你选的条件有问题，是数据集背后的 SQL 跑不通。',
      reasons: [
        owner ? `找数据集负责人：${owner}` : '数据集没写负责人，可在配置页补上',
        '常见原因：底层表改名 / 删列，或聚合表达式引用了不存在的字段',
      ],
      actions: [{ kind: 'clearFilter', label: '清空筛选条件再试一次' }],
      raw,
    };
  }

  return {
    title: '查询没有跑成功',
    detail: '下面是服务端返回的原始错误，一般能在里面找到关键字。',
    reasons: ['可以先试试清空筛选条件，排除条件写法的问题'],
    actions: [{ kind: 'clearFilter', label: '清空筛选条件' }],
    raw,
  };
}

// ── 空结果 ────────────────────────────────────────────────────────────
export function diagnoseEmpty(ctx: DiagnoseCtx & { elapsedMs: number }): Diagnosis {
  const { dataset, dims, metrics, filterTree, labelOf } = ctx;
  const pruned = pruneEmpty(filterTree);

  // 把条件摊平：空结果最常见的成因就是「某一条筛太狠」，
  // 逐条给「去掉」按钮，比让用户自己在脑子里做排除法快得多。
  const leaves: Array<{ field: string; value: string; text: string }> = [];
  const walk = (n?: FilterNode | null) => {
    if (!n) return;
    if (n.field) {
      const value = Array.isArray(n.values) && n.values.length > 0 ? n.values.join('、') : (n.value ?? '');
      leaves.push({ field: n.field, value, text: `${labelOf(n.field)} ${n.op ?? '='} ${value}` });
    }
    n.children?.forEach(walk);
  };
  walk(pruned);

  if (leaves.length > 0) {
    return {
      title: '查完了，但没有任何一行同时满足这些条件',
      detail: `数据集「${dataset?.dataset_name ?? '未知'}」本身有数据，是筛选把它们全筛掉了（${describeFilter(pruned, labelOf)}）。`,
      reasons: [
        '逐个去掉条件试：空结果 90% 是某一条筛太狠或者写错了值',
        '日期区间是不是写反了 / 写成了未来时间',
        '维度取值里的空格、大小写、前后缀是否和数据库里一致',
      ],
      actions: [
        ...leaves.slice(0, 6).map((l) => ({
          kind: 'dropFilter' as const,
          field: l.field,
          value: l.value,
          label: `去掉「${l.text}」`,
        })),
        { kind: 'clearFilter', label: '清空全部筛选条件' },
      ],
    };
  }

  if (dims.length === 0 && metrics.length === 0) {
    return {
      title: '还没选要查什么',
      detail: '维度和指标都是空的，没有可以执行的查询。',
      reasons: ['在左侧勾一个维度（按什么分组）和一个指标（看什么数）'],
      actions: [],
    };
  }

  return {
    title: '这个数据集当前查不到任何数据行',
    detail: `没有筛选条件，仍然返回 0 行（耗时 ${ctx.elapsedMs} ms），说明数据集背后的表是空的或行级过滤把它们全滤掉了。`,
    reasons: [
      dataset?.meta?.update_freq ? `数据集标注的更新频率：${dataset.meta.update_freq}` : '数据集没写更新频率，不确定数据是否应该已经到齐',
      '如果数据集配了行级过滤（按登录态租户/用户），换一个租户试试',
      dataset?.meta?.owner ? `数据集负责人：${dataset.meta.owner}` : '数据集没写负责人，可在配置页补上',
    ],
    actions: [],
  };
}
