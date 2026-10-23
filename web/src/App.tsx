import { useState } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { App as AntApp, Input, Layout, Menu, Space, Typography } from 'antd';
import { AppstoreOutlined, BarChartOutlined } from '@ant-design/icons';
import DatasourceList from './pages/DatasourceList';
import QueryPage from './pages/QueryPage';

const OPERATOR_KEY = 'ds_operator';

const menuItems = [
  { key: '/datasources', icon: <AppstoreOutlined />, label: '配置管理' },
  { key: '/query', icon: <BarChartOutlined />, label: '可视化查询' },
];

export default function App() {
  const { message } = AntApp.useApp();
  const navigate = useNavigate();
  const location = useLocation();
  const [operator, setOperator] = useState(() => localStorage.getItem(OPERATOR_KEY) || 'system');

  // 系统不接鉴权，操作人由使用者自报并存在本地，随请求头 X-User 带给后端审计。
  const onOperatorChange = (value: string) => {
    const v = value.trim() || 'system';
    setOperator(v);
    localStorage.setItem(OPERATOR_KEY, v);
    message.success(`操作人已切换为 ${v}`);
  };

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Layout.Header
        style={{
          background: '#fff',
          borderBottom: '1px solid #f0f0f0',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <Typography.Title level={5} style={{ margin: 0 }}>
          Datasource 服务
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
      <Layout>
        <Layout.Sider width={160} theme="light" style={{ borderRight: '1px solid #f0f0f0' }}>
          <Menu
            mode="inline"
            selectedKeys={[location.pathname]}
            items={menuItems}
            onClick={({ key }) => navigate(key)}
            style={{ borderInlineEnd: 'none', marginTop: 8 }}
          />
        </Layout.Sider>
        <Layout.Content style={{ padding: 24, background: '#f5f5f5' }}>
          <Routes>
            <Route path="/" element={<Navigate to="/datasources" replace />} />
            <Route path="/datasources" element={<DatasourceList />} />
            <Route path="/query" element={<QueryPage />} />
            <Route path="*" element={<Navigate to="/datasources" replace />} />
          </Routes>
        </Layout.Content>
      </Layout>
    </Layout>
  );
}
