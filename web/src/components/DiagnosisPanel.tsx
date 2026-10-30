import { Button, Collapse, Space, Typography } from 'antd';
import { CopyOutlined } from '@ant-design/icons';
import type { Diagnosis, FixAction } from '../utils/diagnose';

interface Props {
  diagnosis: Diagnosis;
  // 空结果不是报错，用更轻的语气；报错才用红
  tone: 'error' | 'empty';
  onFix: (action: FixAction) => void;
  busy?: boolean;
}

export default function DiagnosisPanel({ diagnosis, tone, onFix, busy }: Props) {
  const { title, detail, reasons, actions, raw } = diagnosis;
  const accent = tone === 'error' ? '#ff4d4f' : '#faad14';

  return (
    <div style={{ padding: '4px 0 8px' }}>
      <Space align="start" size={10} style={{ marginBottom: 8 }}>
        <span
          aria-hidden
          style={{
            width: 8,
            height: 8,
            borderRadius: 999,
            background: accent,
            marginTop: 8,
            flex: '0 0 auto',
          }}
        />
        <div>
          <Typography.Text strong style={{ fontSize: 15 }}>
            {title}
          </Typography.Text>
          {detail && (
            <div>
              <Typography.Text type="secondary">{detail}</Typography.Text>
            </div>
          )}
        </div>
      </Space>

      {reasons.length > 0 && (
        <ul style={{ margin: '0 0 12px', paddingLeft: 20 }}>
          {reasons.map((r, i) => (
            <li key={i}>
              <Typography.Text style={{ fontSize: 13 }}>{r}</Typography.Text>
            </li>
          ))}
        </ul>
      )}

      {actions.length > 0 && (
        <Space wrap size={8} style={{ marginBottom: 4 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            一键修复
          </Typography.Text>
          {actions.map((a, i) => (
            <Button key={i} size="small" type={i === 0 ? 'primary' : 'default'} loading={busy} onClick={() => onFix(a)}>
              {a.label}
            </Button>
          ))}
        </Space>
      )}

      {raw && (
        <Collapse
          ghost
          size="small"
          style={{ marginTop: 8 }}
          items={[
            {
              key: 'raw',
              label: <Typography.Text type="secondary" style={{ fontSize: 12 }}>原始错误（排查用）</Typography.Text>,
              children: (
                <div>
                  <Space align="start">
                    <Typography.Text code style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                      {raw}
                    </Typography.Text>
                    <Button
                      size="small"
                      type="text"
                      icon={<CopyOutlined />}
                      onClick={() => void navigator.clipboard?.writeText(raw)}
                    />
                  </Space>
                </div>
              ),
            },
          ]}
        />
      )}
    </div>
  );
}
