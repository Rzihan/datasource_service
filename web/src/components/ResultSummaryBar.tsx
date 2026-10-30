import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Button, Card, Col, Row, Space, Statistic, Tag, Typography } from 'antd';
import { DatabaseOutlined, FieldTimeOutlined, ThunderboltOutlined } from '@ant-design/icons';
import type { QueryResult } from '../types';

// 结果第一屏要回答三个「元信息」问题：
//   1. 一共多少行、是不是全量（截断只给一个小 Tag 等于没说）
//   2. 慢不慢（耗时）
//   3. 数据覆盖到哪天（T+1 的数据，不知道边界就会按今天去解读）
// 指标的量级不在这里，交给下面的 MetricCards —— 一个数只该出现在一个地方，
// 概览条和卡片都显示一遍「合计 94,571,410」，只会让人怀疑是不是两个数。
interface Props {
  result: QueryResult;
  limit: number;
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

export default function ResultSummaryBar({ result, limit, onLimitChange, actions }: Props) {
  const [raising, setRaising] = useState<number | null>(null);
  const temporal = useMemo(() => findTemporalColumn(result), [result]);

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
