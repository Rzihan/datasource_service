import { useState } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { App as AntApp, Input, Layout, Menu, Select, Space, Typography } from 'antd';
import { AppstoreOutlined, BarChartOutlined } from '@ant-design/icons';
import DatasourceList from './pages/DatasourceList';
import QueryPage from './pages/QueryPage';
import { readTenants, readVisibleUsers, writeTenants, writeVisibleUsers } from './identity';

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
  const [tenants, setTenants] = useState<string[]>(readTenants);
  const [visibleUsers, setVisibleUsers] = useState<string[]>(readVisibleUsers);

  // 系统不接鉴权，操作人由使用者自报并存在本地，随请求头 X-User 带给后端审计。
  const onOperatorChange = (value: string) => {
    const v = value.trim() || 'system';
    setOperator(v);
    localStorage.setItem(OPERATOR_KEY, v);
    message.success(`操作人已切换为 ${v}`);
  };

  // 登录态租户可以多选。数据源的 acl.tenants 非空时，与这里取交集才可见。
  const onTenantsChange = (value: string[]) => {
    setTenants(value);
    writeTenants(value);
  };

  // 登录态可见用户可以多选，用于行级过滤的 user 规则。
  // 留空时，开了该规则的数据源按 fail-closed 处理：查不到任何行。
  const onVisibleUsersChange = (value: string[]) => {
    setVisibleUsers(value);
    writeVisibleUsers(value);
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
          <Typography.Text type="secondary">登录态租户</Typography.Text>
          <Select
            mode="tags"
            size="small"
            style={{ minWidth: 220 }}
            value={tenants}
            onChange={onTenantsChange}
            placeholder="留空=不指定租户"
            tokenSeparators={[',']}
            maxTagCount={3}
          />
          <Typography.Text type="secondary">可见用户</Typography.Text>
          <Select
            mode="tags"
            size="small"
            style={{ minWidth: 200 }}
            value={visibleUsers}
            onChange={onVisibleUsersChange}
            placeholder="留空=不代看任何用户"
            tokenSeparators={[',']}
            maxTagCount={3}
          />
          <Typography.Text type="secondary">操作人</Typography.Text>
          <Input
            size="small"
            style={{ width: 130 }}
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
