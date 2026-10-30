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
