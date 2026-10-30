import { useEffect, useMemo, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { App as AntApp, Input, Layout, Menu, Segmented, Select, Space, Tooltip, Typography } from 'antd';
import { AppstoreOutlined, BarChartOutlined, SwapOutlined, TagsOutlined } from '@ant-design/icons';
import DatasetList from './pages/DatasetList';
import EntryPage from './pages/EntryPage';
import LabelList from './pages/LabelList';
import LegacyPage from './pages/LegacyPage';
import MigrationBoard from './pages/MigrationBoard';
import QueryPage from './pages/QueryPage';
import { fetchQueryDatasets } from './api';
import type { QueryDataset } from './types';
import { readTenants, readVisibleUsers, subscribeTenants, writeTenants, writeVisibleUsers } from './identity';
import type { Density } from './utils/prefs';
import { setPrefs, usePrefs } from './utils/prefs';
import { buildMenuGroups, collectEntries, entryMenuLabel } from './utils/entries';
import { prefersLegacy, subscribeMigration } from './utils/migration';

const OPERATOR_KEY = 'ds_operator';

interface MenuItem {
  key: string;
  label: React.ReactNode;
}

// 菜单项上的角标。用自绘的一小块而不是 antd Tag：菜单项内部再套组件
// 会把行高撑开，一排菜单看着参差不齐。
function MenuLabel({ text, badge }: { text: string; badge?: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span>{text}</span>
      {badge && (
        <span
          style={{
            fontSize: 11,
            color: '#fff',
            background: '#1677ff',
            borderRadius: 4,
            padding: '0 4px',
            lineHeight: '16px',
          }}
        >
          {badge}
        </span>
      )}
    </span>
  );
}

const fixedMenuItems = [
  { key: '/datasets', icon: <AppstoreOutlined />, label: '配置管理' },
  { key: '/labels', icon: <TagsOutlined />, label: '字段名称' },
  { key: '/query', icon: <BarChartOutlined />, label: '可视化查询' },
  { key: '/migration', icon: <SwapOutlined />, label: '迁移看板' },
];

export default function App() {
  const { message } = AntApp.useApp();
  const navigate = useNavigate();
  const location = useLocation();
  const [operator, setOperator] = useState(() => localStorage.getItem(OPERATOR_KEY) || 'system');
  const [tenants, setTenants] = useState<string[]>(readTenants);
  const [visibleUsers, setVisibleUsers] = useState<string[]>(readVisibleUsers);
  // 界面档位：全局偏好而不是页面内状态——切换后所有页面立刻生效，也不用每次重设
  const prefs = usePrefs();
  // 菜单要按数据集上的入口配置渲染，所以这里也得知道有哪些数据集。
  // 租户一变可见数据集就变，菜单跟着变——看不到的数据集不该在菜单上留个空链接。
  const [datasets, setDatasets] = useState<QueryDataset[]>([]);

  useEffect(() => {
    const load = () => {
      fetchQueryDatasets()
        .then((res) => setDatasets(res.items ?? []))
        .catch(() => setDatasets([]));
    };
    void load();
    return subscribeTenants(() => void load());
  }, []);

  // 迁移看板改完入口状态要立刻看到新菜单，所以给它一个重拉的方法
  const reloadDatasets = () => {
    fetchQueryDatasets()
      .then((res) => setDatasets(res.items ?? []))
      .catch(() => setDatasets([]));
  };

  // 用户在旧页面上的表态会影响菜单去向（比如他说了「以后再说」），所以要订阅
  const [migrateVersion, setMigrateVersion] = useState(0);
  useEffect(() => subscribeMigration(() => setMigrateVersion((v) => v + 1)), []);

  // 菜单项由入口动态生成。同一个菜单会长成三种样子，取决于迁移状态：
  //   并存   旧页 + 「（可视化查询版）」两条都在
  //   默认   只剩一条，点进去是新版（旧页仍可从新版里退回）
  //   替换   只剩一条，且名字已经变回原页面名——后缀是过渡期的标记，不该留一辈子
  const menuItems = useMemo(() => {
    const groups = buildMenuGroups(collectEntries(datasets));
    return [
      ...fixedMenuItems,
      ...groups.map((g) => ({
        key: `module:${g.module}`,
        label: g.module,
        children: g.pages.flatMap<MenuItem>((slot) => {
          const e = slot.entries[0];
          if (slot.orphan) {
            return [{ key: `/e/${e.key}`, label: e.title }];
          }
          if (!e) {
            return [{ key: `/legacy/${slot.page.key}`, label: slot.page.title }];
          }
          if (e.status === 'replaced') {
            // 名字变回原页面名：后缀是过渡期的标记，不该在菜单上挂一辈子
            return [{ key: `/e/${e.key}`, label: slot.page.title }];
          }
          if (e.status === 'default') {
            // 尊重个人选择：他说过以后再说，就还是进旧页
            return prefersLegacy(slot.page.key)
              ? [{ key: `/legacy/${slot.page.key}`, label: slot.page.title }]
              : [{ key: `/e/${e.key}`, label: <MenuLabel text={slot.page.title} badge="新" /> }];
          }
          return [
            { key: `/legacy/${slot.page.key}`, label: slot.page.title },
            { key: `/e/${e.key}`, label: entryMenuLabel(e) },
          ];
        }),
      })),
    ];
    // migrateVersion 不出现在计算里，但它是「用户改了表态」的信号，必须触发重算
  }, [datasets, migrateVersion]);

  // 系统不接鉴权，操作人由使用者自报并存在本地，随请求头 X-User 带给后端审计。
  const onOperatorChange = (value: string) => {
    const v = value.trim() || 'system';
    setOperator(v);
    localStorage.setItem(OPERATOR_KEY, v);
    message.success(`操作人已切换为 ${v}`);
  };

  // 登录态租户可以多选。数据集的 acl.tenants 非空时，与这里取交集才可见。
  const onTenantsChange = (value: string[]) => {
    setTenants(value);
    writeTenants(value);
  };

  // 登录态可见用户可以多选，用于行级过滤的 user 规则。
  // 留空时，开了该规则的数据集按 fail-closed 处理：查不到任何行。
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
          Dataset 服务
        </Typography.Title>
        <Space size="small">
          <Tooltip title="简洁档收起口径说明、推荐提示、预置分析等引导性内容；完整档全部展开">
            <Segmented
              size="small"
              value={prefs.density}
              onChange={(v) => setPrefs({ density: v as Density })}
              options={[
                { label: '简洁', value: 'compact' },
                { label: '完整', value: 'full' },
              ]}
            />
          </Tooltip>
          <Typography.Text type="secondary">租户</Typography.Text>
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
        <Layout.Sider width={208} theme="light" style={{ borderRight: '1px solid #f0f0f0' }}>
          <Menu
            mode="inline"
            selectedKeys={[location.pathname]}
            items={menuItems}
            onClick={({ key }) => {
              if (key.startsWith('/')) navigate(key);
            }}
            style={{ borderInlineEnd: 'none', marginTop: 8 }}
          />
        </Layout.Sider>
        <Layout.Content style={{ padding: 24, background: '#f5f5f5' }}>
          <Routes>
            <Route path="/" element={<Navigate to="/datasets" replace />} />
            <Route path="/datasets" element={<DatasetList />} />
            <Route path="/labels" element={<LabelList />} />
            <Route path="/query" element={<QueryPage />} />
            <Route path="/migration" element={<MigrationBoard datasets={datasets} onReload={reloadDatasets} />} />
            {/* 挂在旧菜单下的入口：/e/{入口 key}，数据集与默认视图由入口配置决定 */}
            <Route path="/e/:entryKey" element={<EntryPage datasets={datasets} onReload={reloadDatasets} />} />
            {/* 存量页面：系统里那些写死的表格页 / 看板页 */}
            <Route path="/legacy/:pageKey" element={<LegacyPage datasets={datasets} />} />
            <Route path="*" element={<Navigate to="/datasets" replace />} />
          </Routes>
        </Layout.Content>
      </Layout>
    </Layout>
  );
}
