import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Button, Card, Col, Row, Space, Statistic, Tag, Tooltip, Typography } from 'antd';
import { DatabaseOutlined, FieldTimeOutlined, ThunderboltOutlined } from '@ant-design/icons';
import type { QueryResult, StringMap } from '../types';
import { columnDigits, formatScaled, numericText, sumColumn } from '../utils/format';

// 结果第一屏要回答四个问题才配叫「看板」：
//   1. 一共多少行、是不是全量（截断只给一个小 Tag 等于没说）
//   2. 慢不慢（耗时）
//   3. 数据覆盖到哪天（T+1 的数据，不知道边界就会按今天去解读）
//   4. 总量大概多少（一行行扫下来看不出规模）
interface Props {
  result: QueryResult;
  limit: number;
  labelMap: StringMap;
  // 可加性已在上层算好：比率/均值/去重不能逐行相加，加出来是一眼错的数
  nonAdditive?: string[];
  // 放宽上限后由上层带着新 limit 重查——前端已有全部结果，但限制是后端给的
  onLimitChange?: (limit: number) => void;
  // 「计算列 / 下载 CSV」这类工具按钮跟着概览条排，不另起一行浪费纵向空间
  actions?: ReactNode;
}

const CANDIDATE_LIMITS = [1000, 5000, 10000];

// 结果里的时间列：认得 ISO 日期 / 日期时间就够了，不做类型推断。
// 用它算「数据覆盖区间」，否则用户不知道自己看的是哪段时间的数。
const DATE_RE = /^\d{4}-\d{2}(-\d{2})?([ T]\d{2}:\d{2}(:\d{2})?)?$/;

function findTemporalColumn(result: QueryResult): { idx: number; min: string; max: string } | null {
  for (let c = 0; c < result.columns.length; c += 1) {
    const values = result.rows.map((r) => r[c]).filter((v) => v !== null && v !== undefined);
    if (values.length < 2) continue;
    if (!values.every((v) => DATE_RE.test(String(v)))) continue;
    const sorted = [...new Set(values.map(String))].sort();
    return { idx: c, min: sorted[0].slice(0, 10), max: sorted[sorted.length - 1].slice(0, 10) };
  }
  return null;
}

// 概览卡里的「总量」只取第一个可加的数值列：
// 四个维度同时在看的时候，把每列都加起来反而没有重点。
function pickSummaryColumn(result: QueryResult, labelMap: StringMap, nonAdditive: Set<string>) {
  for (let c = 0; c < result.columns.length; c += 1) {
    const name = result.columns[c].name;
    if (nonAdditive.has(name)) continue;
    const values = result.rows.map((r) => r[c]);
    if (!values.some((v) => numericText(v) !== null)) continue;
    const digits = columnDigits(values);
    return {
      title: labelMap[name] || name,
      value: formatScaled(sumColumn(values, digits), digits),
      unit: result.rows.length,
    };
  }
  return null;
}

export default function ResultSummaryBar({
  result,
  limit,
  labelMap,
  nonAdditive = [],
  onLimitChange,
  actions,
}: Props) {
  const [raising, setRaising] = useState<number | null>(null);

  const temporal = useMemo(() => findTemporalColumn(result), [result]);
  const nonAdditiveSet = useMemo(() => new Set(nonAdditive), [nonAdditive]);
  const summary = useMemo(
    () => pickSummaryColumn(result, labelMap, nonAdditiveSet),
    [result, labelMap, nonAdditiveSet],
  );

  const raise = (next: number) => {
    if (!onLimitChange) return;
    setRaising(next);
    onLimitChange(next);
    // 重查是异步的，这里只负责把「点了」的状态在按钮上表示出来
    setTimeout(() => setRaising(null), 1500);
  };

  const nextLimits = CANDIDATE_LIMITS.filter((n) => n > limit);

  return (
    <div style={{ marginBottom: 12 }}>
      <Row gutter={12} align="middle">
        <Col flex="auto">
          <Card size="small" styles={{ body: { paddingBlock: 8 } }}>
            <Row gutter={16} wrap>
              <Col>
                <Statistic
                  title={
                    <Space size={4}>
                      <DatabaseOutlined />
                      结果行数
                    </Space>
                  }
                  value={result.row_count}
                  suffix={result.truncated ? <Tag color="warning">已截断</Tag> : null}
                  valueStyle={{ fontSize: 20 }}
                />
              </Col>
              <Col>
                <Statistic
                  title={
                    <Space size={4}>
                      <ThunderboltOutlined />
                      耗时
                    </Space>
                  }
                  value={result.elapsed_ms}
                  suffix="ms"
                  valueStyle={{ fontSize: 20, color: result.elapsed_ms > 3000 ? '#cf1322' : undefined }}
                />
              </Col>
              {temporal && (
                <Col>
                  <Statistic
                    title={
                      <Space size={4}>
                        <FieldTimeOutlined />
                        数据覆盖
                      </Space>
                    }
                    value={`${temporal.min} ~ ${temporal.max}`}
                    valueStyle={{ fontSize: 20 }}
                  />
                </Col>
              )}
              {summary && (
                <Col>
                  <Tooltip title={`${summary.title}：当前返回全部行的合计（比率 / 均值 / 去重类不参与）`}>
                    <Statistic
                      title={`${summary.title}（合计）`}
                      value={summary.value}
                      valueStyle={{ fontSize: 20, cursor: 'help' }}
                    />
                  </Tooltip>
                </Col>
              )}
            </Row>
          </Card>
        </Col>
        {actions && <Col>{actions}</Col>}
      </Row>

      {result.truncated && (
        <Alert
          type="warning"
          showIcon
          style={{ marginTop: 8 }}
          message={
            <Space size={4} wrap>
              <Typography.Text>
                结果不是全量：已按返回上限 <Typography.Text strong>{limit}</Typography.Text> 行截断
              </Typography.Text>
              {nextLimits.length > 0 && onLimitChange ? (
                <>
                  {nextLimits.map((n) => (
                    <Button key={n} size="small" type="link" loading={raising === n} onClick={() => raise(n)}>
                      放宽到 {n}
                    </Button>
                  ))}
                </>
              ) : (
                <Typography.Text type="secondary">已是最大上限</Typography.Text>
              )}
            </Space>
          }
          description="指标已经过聚合，合计行与图表都只覆盖这部分的「部分合计」，用于汇报前请放宽上限或加筛选条件。"
        />
      )}
    </div>
  );
}
