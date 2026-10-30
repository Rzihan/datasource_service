import { useMemo } from 'react';
import { Card, Col, Row, Tooltip, Typography } from 'antd';
import type { CompareMeta, QueryResult, StringMap } from '../types';
import { columnDigits, formatScaled, numericText, parseScaled, sumColumn } from '../utils/format';

// 查完数第一眼看的不是表，是「规模有多大、集中在谁身上」。
// 只有一张表时，二十行数字要自己心算，一屏看不出任何结论。
//
// 每张卡只回答一个问题，并且**只放能算准的数**：
//   · 可加指标（sum）→ 合计 + 最高值是谁、占多少
//   · 不可加指标（比率 / 均值 / 去重）→ 不给合计，只给行均值与范围，
//     因为分组比率相加得到的是「百分比之和」，一眼就是错的数。
interface Props {
  result: QueryResult;
  dims: string[];
  metrics: string[];
  labelMap: StringMap;
  nonAdditive: string[];
  // 有对比周期时，卡片多一行「环比 +12.4%」——这是看板上最想先看到的那个数
  compare?: CompareMeta;
}

const MAX_CARDS = 4;
const DATE_RE = /^\d{4}-\d{2}(-\d{2})?([ T]\d{2}:\d{2}(:\d{2})?)?$/;

// 迷你趋势线：用内联 SVG 画，不为一条 40px 的线去拉 400KB 的图表库。
// 只表达「形状」，不画坐标轴——精确值在下面的表里。
function Sparkline({ values }: { values: Array<number | null> }) {
  const nums = values.filter((v): v is number => v !== null);
  if (nums.length < 3) return null;
  const w = 64;
  const h = 24;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  if (max === min) return null; // 一条直线没有信息量，别占地方
  const span = max - min;
  const pts = nums
    .map((v, i) => {
      const x = (i / (nums.length - 1)) * w;
      const y = h - ((v - min) / span) * (h - 4) - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const up = nums[nums.length - 1] >= nums[0];
  const color = up ? '#cf1322' : '#3f8600';
  return (
    <svg width={w} height={h} style={{ display: 'block' }} aria-hidden>
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round" />
    </svg>
  );
}

export default function MetricCards({ result, dims, metrics, labelMap, nonAdditive, compare }: Props) {
  const nonAdditiveSet = useMemo(() => new Set(nonAdditive), [nonAdditive]);

  // 时间列：X 轴是日期时，卡片上带一条迷你趋势
  const timeIdx = useMemo(() => {
    for (let c = 0; c < result.columns.length; c += 1) {
      const vals = result.rows.map((r) => r[c]).filter((v) => v !== null && v !== undefined);
      if (vals.length >= 3 && vals.every((v) => DATE_RE.test(String(v)))) return c;
    }
    return -1;
  }, [result]);

  const firstDimIdx = useMemo(() => {
    const d = dims.find((x) => result.columns.some((c) => c.name === x));
    return d ? result.columns.findIndex((c) => c.name === d) : -1;
  }, [result, dims]);

  const cards = useMemo(() => {
    return metrics
      .map((m) => {
        const idx = result.columns.findIndex((c) => c.name === m);
        if (idx < 0) return null;
        const values = result.rows.map((r) => r[idx]);
        if (!values.some((v) => numericText(v) !== null)) return null;

        const digits = columnDigits(values);
        const additive = !nonAdditiveSet.has(m);
        const total = sumColumn(values, digits);
        const scale = 10n ** BigInt(digits);

        // 最高值所在行（用定点比较，不经 float）
        let topIdx = -1;
        let topVal: bigint | null = null;
        values.forEach((v, i) => {
          const s = parseScaled(v, digits);
          if (s === null) return;
          if (topVal === null || s > topVal) {
            topVal = s;
            topIdx = i;
          }
        });

        const topName =
          topIdx >= 0 && firstDimIdx >= 0 ? String(result.rows[topIdx][firstDimIdx] ?? '(空值)') : '';
        // 占比：只在合计为正时给，否则会算出负占比/无穷大
        const share = additive && total > 0n && topVal !== null ? Number((topVal * 10000n) / total) / 100 : null;

        const numeric = values
          .map((v) => parseScaled(v, digits))
          .map((v) => (v === null ? null : Number(v) / Number(scale)));

        // 维度是日期时，「最高」的说法不对——那是峰值，且要带上具体哪天
        const dimIsTime = firstDimIdx >= 0 && timeIdx >= 0 && firstDimIdx === timeIdx;
        const lead = dimIsTime ? '峰值' : '最高';

        let big: string;
        let sub: string;
        if (additive) {
          big = formatScaled(total, digits);
          sub =
            topName && share !== null && result.rows.length > 1
              ? `${lead} ${topName} · ${share.toFixed(1)}%`
              : result.rows.length > 1
                ? `${result.rows.length} 个分组`
                : '汇总';
        } else {
          const counted = numeric.filter((v): v is number => v !== null);
          const mean = counted.length > 0 ? counted.reduce((a, b) => a + b, 0) / counted.length : 0;
          const lo = counted.length > 0 ? Math.min(...counted) : 0;
          const hi = counted.length > 0 ? Math.max(...counted) : 0;
          // 整数指标（在岗人数）不该拖两位小数；均值又确实可能有小数，
          // 所以按「是不是整数」决定，而不是一律保留两位。
          const dp = digits > 0 ? digits : Number.isInteger(mean) ? 0 : 1;
          big = mean.toFixed(dp);
          sub =
            counted.length <= 1
              ? '单项值'
              : lo === hi
                ? `各分组相同（${counted.length} 个）`
                : `行均值 · 范围 ${lo.toFixed(dp)} ~ ${hi.toFixed(dp)}`;
        }

        // 环比：可加指标比相对变化，比率类比百分点差
        let delta: { text: string; up: boolean; flat: boolean } | null = null;
        const prevArr = compare?.prev_values?.[m];
        if (prevArr && prevArr.length > 0) {
          if (additive) {
            const prevTotal = sumColumn(prevArr, digits);
            if (prevTotal !== 0n) {
              const pct = (Number(total - prevTotal) / Math.abs(Number(prevTotal))) * 100;
              delta = {
                text: `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`,
                up: pct > 0,
                flat: Math.abs(pct) < 0.05,
              };
            }
          } else {
            const prevNums = prevArr.map((v) => parseScaled(v, digits)).filter((v): v is bigint => v !== null);
            if (prevNums.length > 0) {
              const prevMean = Number(prevNums.reduce((a, b) => a + b, 0n)) / prevNums.length / Number(scale);
              const curNums = numeric.filter((v): v is number => v !== null);
              const curMean = curNums.length > 0 ? curNums.reduce((a, b) => a + b, 0) / curNums.length : 0;
              const pp = curMean - prevMean;
              delta = {
                text: `${pp > 0 ? '+' : ''}${pp.toFixed(digits > 0 ? digits : 2)}pp`,
                up: pp > 0,
                flat: Math.abs(pp) < 1e-9,
              };
            }
          }
        }

        return {
          key: m,
          title: labelMap[m] || m,
          big,
          sub,
          delta,
          hint: additive
            ? '可累加指标：所有返回行求和'
            : '比率/均值/去重类指标不能相加，这里显示的是各分组值的算术平均，整体口径请去掉分组再查一次',
          spark: timeIdx >= 0 ? numeric : null,
        };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null)
      .slice(0, MAX_CARDS);
  }, [metrics, result, nonAdditiveSet, timeIdx, firstDimIdx, labelMap, compare]);

  if (cards.length === 0) return null;

  const span = cards.length >= 4 ? 6 : cards.length === 3 ? 8 : cards.length === 2 ? 12 : 24;

  return (
    <Row gutter={12} style={{ marginBottom: 12 }}>
      {cards.map((c) => (
        <Col key={c.key} xs={24} sm={12} md={span}>
          <Tooltip title={c.hint}>
            <Card size="small" hoverable styles={{ body: { padding: '10px 14px' } }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {c.title}
              </Typography.Text>
              <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 8 }}>
                <div
                  style={{
                    // 94,571,410 这种长数字在窄卡片里会被折成两行，看起来像两个值。
                    // 按长度收字号，宁可小一点也要保持一行。
                    fontSize: c.big.length > 12 ? 20 : c.big.length > 9 ? 23 : 26,
                    lineHeight: '34px',
                    fontWeight: 600,
                    fontVariantNumeric: 'tabular-nums',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                  title={c.big}
                >
                  {c.big}
                </div>
                {/* 数字太长、或卡片太窄时不给趋势线留位置：
                    被压成「1,440 …」的卡片失去意义，趋势线本来只是辅助。
                    四张卡并排时每张只有 150px，64px 的趋势线会把数字挤断。 */}
                {c.spark && c.big.length <= 9 && cards.length <= 3 && (
                  <div style={{ flexShrink: 0 }}>
                    <Sparkline values={c.spark} />
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                {c.delta && (
                  <span
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      fontVariantNumeric: 'tabular-nums',
                      color: c.delta.flat ? '#8c8c8c' : c.delta.up ? '#cf1322' : '#3f8600',
                    }}
                  >
                    {compare?.mode === 'prev_year' ? '同比' : '环比'} {c.delta.text}
                  </span>
                )}
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {c.sub}
                </Typography.Text>
              </div>
            </Card>
          </Tooltip>
        </Col>
      ))}
    </Row>
  );
}
