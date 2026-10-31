import { useState } from 'react';
import { App as AntApp, Button, Card, Input, Space, Tag, Typography } from 'antd';
import { LockOutlined, UserOutlined } from '@ant-design/icons';
import { devLogin } from '../api';
import { setToken } from '../auth';
import type { AuthModeInfo, Identity } from '../auth';

interface Props {
  info: AuthModeInfo;
  onLoggedIn: () => void;
}

// 登录页刻意做得很薄：这个平台不自己管账号，真实环境的身份由企业 IdP 下发。
// dev 模式「选一个身份」而不是输用户名密码——本地与演示要能一键进去看数，
// 为演示专门维护一套密码体系不值得。
export default function Login({ info, onLoggedIn }: Props) {
  const { message } = AntApp.useApp();
  const [busy, setBusy] = useState('');
  const [pasted, setPasted] = useState('');

  const enter = async (user: string) => {
    setBusy(user);
    try {
      const res = await devLogin(user);
      setToken(res.token);
      message.success(`已以 ${res.identity.user} 身份进入`);
      onLoggedIn();
    } catch (e) {
      message.error((e as Error).message || '登录失败');
    } finally {
      setBusy('');
    }
  };

  // 企业 token 粘贴入口：sso 跳转在本地联调时往往用不上（没有回调地址），
  // 留一个手填口子，就能直接拿真实 token 验证鉴权链路。
  const usePastedToken = () => {
    const t = pasted.trim();
    if (!t) {
      message.warning('请先粘贴 token');
      return;
    }
    setToken(t);
    onLoggedIn();
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f5f5f5' }}>
      <Card style={{ width: 520 }} styles={{ body: { padding: 28 } }}>
        <Space direction="vertical" size={4} style={{ width: '100%', marginBottom: 20 }}>
          <Typography.Title level={4} style={{ margin: 0 }}>
            Dataset 服务
          </Typography.Title>
          <Typography.Text type="secondary">
            {info.login_kind === 'dev' ? '选择一个身份进入（演示模式，无需密码）' : '请使用企业账号登录'}
          </Typography.Text>
        </Space>

        {info.login_kind === 'dev' && (
          <Space direction="vertical" size={10} style={{ width: '100%' }}>
            {info.identities.map((id) => (
              <IdentityRow key={id.user} identity={id} busy={busy === id.user} onEnter={() => void enter(id.user)} />
            ))}
            {info.identities.length === 0 && (
              <Typography.Text type="secondary">没有配置预置身份，请检查 AUTH_DEV_IDENTITIES</Typography.Text>
            )}
          </Space>
        )}

        {info.login_kind === 'sso' && (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            {info.sso_url && (
              <Button type="primary" block icon={<LockOutlined />} href={info.sso_url}>
                前往企业登录
              </Button>
            )}
            <Typography.Text type="secondary">或粘贴企业下发的 token（联调用）</Typography.Text>
            <Input.TextArea
              rows={3}
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              placeholder="eyJhbGciOi..."
              style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 }}
            />
            <Button block onClick={usePastedToken} disabled={!pasted.trim()}>
              使用这个 token
            </Button>
          </Space>
        )}
      </Card>
    </div>
  );
}

function IdentityRow({ identity, busy, onEnter }: { identity: Identity; busy: boolean; onEnter: () => void }) {
  // 后端把空列表序列化成 null（Go 的 nil slice），这里统一兜成空数组
  const roles = identity.roles ?? [];
  const tenants = identity.tenants ?? [];
  const editor = roles.some((r) => ['editor', 'admin'].includes(r.toLowerCase()));
  return (
    <Card size="small" hoverable onClick={onEnter} styles={{ body: { padding: '12px 14px' } }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <Space size={8} wrap>
          <UserOutlined />
          <Typography.Text strong>{identity.user}</Typography.Text>
          <Tag color={editor ? 'blue' : 'default'}>{editor ? '可改配置' : '只读'}</Tag>
          {tenants.length === 0 ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              不限租户
            </Typography.Text>
          ) : (
            tenants.map((t) => (
              <Tag key={t} style={{ marginInlineEnd: 0 }}>
                {t}
              </Tag>
            ))
          )}
        </Space>
        <Button size="small" type="primary" loading={busy} onClick={(e) => { e.stopPropagation(); onEnter(); }}>
          进入
        </Button>
      </div>
    </Card>
  );
}
