import { Button, Skeleton, Space, Tag, Tooltip, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import type { DatasetStats, QueryDataset } from '../types';

interface Props {
  dataset: QueryDataset | null;
  stats: DatasetStats | null;
  loading?: boolean;
  onReload?: () => void;
  // 简洁档：五格明细压成一行。老手每天看同一个数据集，
  // 只需要「48 万行 · 覆盖到 10-30 · 王工」这一句，不需要五组标签。
  compact?: boolean;
}

// 「多久更新一次」翻译成「最多能容忍多久没数据」。
// 没有这层翻译，用户看到「更新频率：每日」和「覆盖到 3 天前」还得自己做一次减法。
function expectedLagDays(freq?: string): number | null {
  if (!freq) return null;
  const f = freq.toLowerCase();
  if (f.includes('实时') || f.includes('小时')) return 1;
  if (f.includes('日') || f.includes('天')) return 2;
  if (f.includes('周')) return 8;
  if (f.includes('月')) return 35;
  return null;
}

function humanCount(n: number): string {
  if (n >= 100000000) return `${(n / 100000000).toFixed(2)} 亿`;
  if (n >= 10000) return `${(n / 10000).toFixed(n >= 1000000 ? 0 : 1)} 万`;
  return n.toLocaleString('zh-CN');
}

export default function DatasetTrustCard({ dataset, stats, loading, onReload, compact }: Props) {
  if (!dataset) return null;

  const meta = dataset.meta ?? {};
  const fieldCount = Object.keys(dataset.dim_map ?? {}).length;
  const multiCount = Object.keys(dataset.multi_dim_map ?? {}).length;
  const mtxCount = Object.keys(dataset.mtx_map ?? {}).length;

  // 新鲜度：只有同时知道「覆盖到哪天」和「多久更新一次」才敢下判断。
  // 两者缺一，就只陈述事实，不猜测——假警报比不报警更伤信任。
  const limit = expectedLagDays(meta.update_freq || stats?.update_freq);
  const lag = stats?.lag_days ?? null;
  const stale = lag !== null && limit !== null && lag > limit;
  const future = lag !== null && lag < 0;

  const item = (label: string, node: React.ReactNode, tip?: string) => (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 11, color: 'rgba(0,0,0,0.45)', lineHeight: '16px' }}>{label}</div>
      <div style={{ fontSize: 13, lineHeight: '20px' }}>
        {tip ? (
          <Tooltip title={tip}>
            <span>{node}</span>
          </Tooltip>
        ) : (
          node
        )}
      </div>
    </div>
  );

  return (
    <div
      style={{
        marginTop: 8,
        padding: '10px 12px',
        border: '1px solid rgba(5,5,5,0.06)',
        borderRadius: 8,
        background: 'rgba(0,0,0,0.02)',
      }}
    >
      <Space size={6} wrap style={{ marginBottom: 6 }}>
        <Typography.Text strong style={{ fontSize: 13 }}>
          {dataset.dataset_name}
        </Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
          {dataset.dataset_key}
        </Typography.Text>
        {(meta.tags ?? []).slice(0, 4).map((t) => (
          <Tag key={t} style={{ marginInlineEnd: 0, fontSize: 11, lineHeight: '16px' }}>
            {t}
          </Tag>
        ))}
      </Space>

      {meta.description && !compact && (
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: '0 0 8px' }}>
          {meta.description}
        </Typography.Paragraph>
      )}

      {loading && !stats ? (
        <Skeleton active paragraph={{ rows: 2 }} title={false} />
      ) : compact ? (
        <div style={{ fontSize: 12, lineHeight: '20px' }}>
          {stats?.error ? (
            <Typography.Text type="secondary">规模扫描没跑出来</Typography.Text>
          ) : (
            <span>
              {humanCount(stats?.row_count ?? 0)} 行
              {stats?.max_date ? ` · 到 ${stats.max_date}（${stats.cover_days} 天）` : ''}
              {` · 维度 ${fieldCount}${multiCount > 0 ? `+${multiCount} 多值` : ''} · 指标 ${mtxCount}`}
              {meta.owner ? ` · ${meta.owner}` : ' · 负责人未填写'}
            </span>
          )}
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(96px, 1fr))',
            gap: '8px 12px',
          }}
        >
          {item(
            '数据行数',
            stats?.error ? <Typography.Text type="secondary">—</Typography.Text> : humanCount(stats?.row_count ?? 0),
            stats ? `扫描耗时 ${stats.elapsed_ms} ms · ${stats.scanned_at}${stats.cached ? '（缓存）' : ''}` : undefined,
          )}
          {item(
            '时间覆盖',
            stats?.min_date ? (
              <span>
                {stats.min_date} ~ {stats.max_date}
                <Typography.Text type="secondary"> · {stats.cover_days} 天</Typography.Text>
              </span>
            ) : (
              <Typography.Text type="secondary">—</Typography.Text>
            ),
            stats?.date_field ? `按字段 ${stats.date_field} 扫描` : undefined,
          )}
          {item(
            '字段',
            <span>
              维度 {fieldCount}
              {multiCount > 0 && ` · 多值 ${multiCount}`} · 指标 {mtxCount}
            </span>,
          )}
          {item(
            '负责人',
            meta.owner ? (
              meta.owner
            ) : (
              <Typography.Text type="secondary">未填写</Typography.Text>
            ),
            meta.owner ? undefined : '没写负责人，出问题不知道找谁',
          )}
          {item(
            '更新频率',
            meta.update_freq || <Typography.Text type="secondary">未填写</Typography.Text>,
          )}
        </div>
      )}

      {(future || stale) && (
        <div style={{ marginTop: 8 }}>
          {future ? (
            <Tag color="warning">数据里有未来日期（{maxDateOf(stats)}），检查时区或录入</Tag>
          ) : (
            <Tag color="warning">
              数据可能滞后：{meta.update_freq}更新，但只到 {maxDateOf(stats)}（{lag} 天前）
            </Tag>
          )}
        </div>
      )}

      {stats?.error && (
        <div style={{ marginTop: 8 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            规模扫描没跑出来：{stats.error}
          </Typography.Text>
          {onReload && (
            <Button size="small" type="link" icon={<ReloadOutlined />} onClick={onReload} style={{ paddingInline: 4 }}>
              重试
            </Button>
          )}
        </div>
      )}

      {!stats?.error && stats?.updated_at && (
        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
          配置更新于 {stats.updated_at}
          {stats.updated_by ? ` · ${stats.updated_by}` : ''}
          {stats.config_version ? ` · 第 ${stats.config_version} 版` : ''}
        </Typography.Text>
      )}
    </div>
  );
}

function maxDateOf(stats: DatasetStats | null): string {
  return stats?.max_date ?? '—';
}
