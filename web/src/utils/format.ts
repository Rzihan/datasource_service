// 展示层的数字格式化：只负责「看着像多少钱」，不参与任何计算。
// 求和用 BigInt 定点，不经过 float —— Decimal(18,2) 的金额加总在表里出现
// 3207849.9199999 这种尾巴，比不显示合计更糟。

const NUMERIC_RE = /^-?\d+(\.\d+)?$/;

// 只有纯数字文本才当数值：NULL / 空串 / '1,234' 原样返回 null
export function numericText(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? String(raw) : null;
  const s = String(raw).trim();
  return NUMERIC_RE.test(s) ? s : null;
}

export function fractionDigits(raw: unknown): number {
  const t = numericText(raw);
  if (t === null) return 0;
  const i = t.indexOf('.');
  return i < 0 ? 0 : t.length - i - 1;
}

// 一列统一的小数位：取该列出现过的最大位数（上限 4）。
// 列内对齐比「每格各自决定」重要——1,234.5 与 12.05 混排，量级一眼看不出来。
export function columnDigits(values: unknown[], cap = 4): number {
  let d = 0;
  for (const v of values) {
    const n = fractionDigits(v);
    if (n > d) d = n;
    if (d >= cap) return cap;
  }
  return d;
}

function scaleOf(digits: number): bigint {
  return BigInt(10) ** BigInt(digits);
}

// 定点解析：1.5 → 15n（digits=1）。全程 bigint，Decimal 的 18 位也不会掉精度。
export function parseScaled(raw: unknown, digits: number): bigint | null {
  const t = numericText(raw);
  if (t === null) return null;
  const neg = t.startsWith('-');
  const body = neg ? t.slice(1) : t;
  const dot = body.indexOf('.');
  const intPart = dot < 0 ? body : body.slice(0, dot);
  const fracPart = dot < 0 ? '' : body.slice(dot + 1);
  const frac = (fracPart + '0'.repeat(digits)).slice(0, digits);
  const v = BigInt(intPart || '0') * scaleOf(digits) + BigInt(frac || '0');
  return neg ? -v : v;
}

export function formatScaled(v: bigint, digits: number): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const s = abs.toString().padStart(digits + 1, '0');
  const intPart = s.slice(0, s.length - digits);
  const frac = digits > 0 ? `.${s.slice(s.length - digits)}` : '';
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${grouped}${frac}`;
}

export function formatNumber(raw: unknown, digits: number): string | null {
  const v = parseScaled(raw, digits);
  return v === null ? null : formatScaled(v, digits);
}

export function sumColumn(values: unknown[], digits: number): bigint {
  let acc = 0n;
  for (const v of values) acc += parseScaled(v, digits) ?? 0n;
  return acc;
}

// ---- 指标能不能逐行相加 ----
//
// 合计行给每个数值列一个数，但三类指标相加纯属噪声：
//   · 去重类 uniq / uniqExact —— 相加等于把同一批人算了好几遍
//   · 均值类 avg —— 各分组均值的和没有任何含义
//   · 比率类 分子 / 分母 —— 相加得到「百分比之和」，比如有效率能加到 1622%
// 反过来，`sum(x) / 3600` 只是换算单位，除数是个常数，仍然可加。
const NON_ADDITIVE_FN =
  /\b(avg|avgWeighted|uniq|uniqExact|uniqCombined|median|medianExact|quantile\w*|stddev\w*|var\w*|corr|entropy)\s*\(/i;

export function isAdditiveMetric(expr: string | undefined): boolean {
  const e = (expr ?? '').trim();
  if (!e) return true;
  if (NON_ADDITIVE_FN.test(e)) return false;
  // 除以字母/括号开头的东西 = 除以另一个列或聚合，是比率；除以数字只是单位换算
  if (/\/\s*[A-Za-z_(]/.test(e)) return false;
  return true;
}
