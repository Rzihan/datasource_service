import { Column, Line } from '@ant-design/charts';

interface Props {
  data: Record<string, unknown>[];
  xField: string;
  yField: string;
  type: 'line' | 'column';
}

// 图表库体积很大，单独成模块由 ResultView 懒加载，
// 不进首屏 chunk。
export default function ChartView({ data, xField, yField, type }: Props) {
  const config = {
    data,
    xField,
    yField,
    height: 340,
    autoFit: true,
    smooth: type === 'line',
    meta: { [yField]: { alias: yField } },
  };
  return type === 'line' ? <Line {...config} /> : <Column {...config} />;
}
