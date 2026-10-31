// 极简趋势线：指标卡下面那一小条。
//
// 为什么不复用 ChartView：图表库 400KB+，大盘为了看几个数字不值得为
// 一条 20px 高的线把整包拉下来。这里就是一个 viewBox 里的 polyline，
// 没有坐标轴、没有交互——它只回答「最近是在涨还是在跌」。
interface Props {
  values: number[];
  width?: number;
  height?: number;
  color?: string;
}

export default function Sparkline({ values, width = 132, height = 34, color = '#1677ff' }: Props) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pad = 3;
  const w = width - pad * 2;
  const h = height - pad * 2;
  const step = w / (values.length - 1);
  const pts = values.map((v, i) => {
    const x = pad + i * step;
    // y 轴翻过来：值越大越靠上
    const y = pad + h - ((v - min) / span) * h;
    return [x, y] as const;
  });
  const line = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${(height - pad).toFixed(1)} L${pts[0][0].toFixed(1)},${(height - pad).toFixed(1)} Z`;
  const [lx, ly] = pts[pts.length - 1];
  const gid = `spark-${color.replace('#', '')}`;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden style={{ display: 'block' }}>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.18} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gid})`} />
      <path d={line} fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={lx} cy={ly} r={2.4} fill={color} />
    </svg>
  );
}
