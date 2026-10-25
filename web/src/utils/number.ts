// 只认真正的数字：NULL / 空串 / 非数字一律返回 null，
// 而不是退化成 0 ——「没数」和「数为 0」在图上必须是两回事。
// 放在 utils 里是因为推荐规则（chartRecommend）也要用同一套判定，
// 图表和推荐不能对「这一格有没有数」给出两种答案。
export function toNumber(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const s = String(raw).trim().replace(/,/g, '');
  if (s === '' || s.toUpperCase() === 'NULL') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
