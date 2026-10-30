// 派生指标：用结果里已有的列做四则运算，生成新列（CPC = 消耗 / 点击）。
//
// 为什么在前端算：两列都已经在内存里，为「A/B」再下发一次查询是浪费；
// 而且派生列的语义必须跟着当前结果走，后端无法知道用户刚才勾了哪些列。
//
// 安全：不用 eval / new Function。表达式先解析成 AST，标识符必须在白名单里，
// 否则直接报错——写错字段名要报错，不能静默算成 0。

export type ExprNode =
  | { t: 'num'; v: number }
  | { t: 'var'; v: string }
  | { t: 'neg'; v: ExprNode }
  | { t: 'op'; op: '+' | '-' | '*' | '/'; l: ExprNode; r: ExprNode };

function tokenize(src: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j += 1;
      out.push(src.slice(i, j));
      i = j;
      continue;
    }
    if (/[A-Za-z_\u4e00-\u9fa5]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_\u4e00-\u9fa5]/.test(src[j])) j += 1;
      out.push(src.slice(i, j));
      i = j;
      continue;
    }
    if ('+-*/()'.includes(c)) {
      out.push(c);
      i += 1;
      continue;
    }
    throw new Error(`不认识的字符「${c}」`);
  }
  return out;
}

export function parseExpression(src: string, allowed: Set<string>): ExprNode {
  const toks = tokenize(src);
  if (toks.length === 0) throw new Error('表达式是空的');
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];

  const parsePrimary = (): ExprNode => {
    const t = next();
    if (t === undefined) throw new Error('表达式不完整');
    if (t === '(') {
      const inner = parseAdd();
      if (next() !== ')') throw new Error('括号不匹配');
      return inner;
    }
    if (t === '-') return { t: 'neg', v: parsePrimary() };
    if (/^[0-9.]+$/.test(t)) {
      const v = Number(t);
      if (!Number.isFinite(v)) throw new Error(`数字「${t}」不合法`);
      return { t: 'num', v };
    }
    if (/^[+\-*/)]$/.test(t)) throw new Error(`「${t}」的位置不对`);
    if (!allowed.has(t)) throw new Error(`未知字段「${t}」：只能用当前结果里的列`);
    return { t: 'var', v: t };
  };
  const parseMul = (): ExprNode => {
    let left = parsePrimary();
    while (peek() === '*' || peek() === '/') {
      const op = next() as '*' | '/';
      left = { t: 'op', op, l: left, r: parsePrimary() };
    }
    return left;
  };
  const parseAdd = (): ExprNode => {
    let left = parseMul();
    while (peek() === '+' || peek() === '-') {
      const op = next() as '+' | '-';
      left = { t: 'op', op, l: left, r: parseMul() };
    }
    return left;
  };

  const root = parseAdd();
  if (p < toks.length) throw new Error(`多余的内容「${toks[p]}」`);
  return root;
}

// 任一操作数为 NULL 时结果就是 NULL——「没数」不能当成 0 参与运算，
// 否则 CPC 会被算成 0，看起来像「不花钱」。
// 除以 0 同样返回 NULL，而不是 Infinity。
export function evalExpression(node: ExprNode, get: (name: string) => number | null): number | null {
  switch (node.t) {
    case 'num':
      return node.v;
    case 'var':
      return get(node.v);
    case 'neg': {
      const v = evalExpression(node.v, get);
      return v === null ? null : -v;
    }
    case 'op': {
      const l = evalExpression(node.l, get);
      const r = evalExpression(node.r, get);
      if (l === null || r === null) return null;
      if (node.op === '+') return l + r;
      if (node.op === '-') return l - r;
      if (node.op === '*') return l * r;
      return r === 0 ? null : l / r;
    }
    default:
      return null;
  }
}

export function referencedFields(node: ExprNode, acc: string[] = []): string[] {
  if (node.t === 'var') acc.push(node.v);
  else if (node.t === 'neg') referencedFields(node.v, acc);
  else if (node.t === 'op') {
    referencedFields(node.l, acc);
    referencedFields(node.r, acc);
  }
  return acc;
}
