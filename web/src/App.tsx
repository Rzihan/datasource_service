import { useState } from 'react';
import { App as AntApp, Card, Input, Layout, Space, Typography } from 'antd';
import DatasourceList from './pages/DatasourceList';

const OPERATOR_KEY = 'ds_operator';

export default function App() {
  const { message } = AntApp.useApp();
  const [operator, setOperator] = useState(() => localStorage.getItem(OPERATOR_KEY) || 'system');

  // 系统不接鉴权，操作人由使用者自报并存在本地，随请求头 X-User 带给后端审计。
  const onOperatorChange = (value: string) => {
    const v = value.trim() || 'system';
    setOperator(v);
    localStorage.setItem(OPERATOR_KEY, v);
    message.success(`操作人已切换为 ${v}`);
  };

  return (
    <Layout style={{ minHeight: '100vh', background: '#f5f5f5' }}>
      <Layout.Header style={{ background: '#fff', borderBottom: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Typography.Title level={5} style={{ margin: 0 }}>
          Datasource 配置
        </Typography.Title>
        <Space size="small">
          <Typography.Text type="secondary">操作人</Typography.Text>
          <Input
            size="small"
            style={{ width: 160 }}
            value={operator}
            placeholder="用于审计"
            onChange={(e) => setOperator(e.target.value)}
            onBlur={(e) => onOperatorChange(e.target.value)}
            onPressEnter={(e) => onOperatorChange((e.target as HTMLInputElement).value)}
          />
        </Space>
      </Layout.Header>
      <Layout.Content style={{ padding: 24 }}>
        <Card>
          <DatasourceList />
        </Card>
      </Layout.Content>
    </Layout>
  );
}
