import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Space, Typography } from 'antd';
import { ArrowRightOutlined } from '@ant-design/icons';
import type { EntryItem } from '../utils/entries';
import { readMigrateChoice, writeMigrateChoice } from '../utils/migration';

interface Props {
  // 替代这一页的那个入口
  entry: EntryItem;
}

// 旧页面上的迁移引导。
//
// 迁移不能只靠「菜单里多了一项」：用户每天的路径是肌肉记忆，
// 他根本不会去看菜单多了什么。所以提示要出现在他正在看的那一页上。
//
// 三种表态对应三种后果，而不是一个「知道了」：
//   立即体验 → 直接带过去，并让他知道是从旧版过来的
//   以后再说 → 提示从一整条降级成一行，不挡内容，但不消失（下次还有机会）
//   不再提示 → 彻底消失。尊重选择，菜单里仍然留着入口
export default function MigrationBanner({ entry }: Props) {
  const navigate = useNavigate();
  const pageKey = entry.legacy ?? '';
  const [choice, setChoice] = useState(readMigrateChoice(pageKey));

  const choose = (next: 'later' | 'never') => {
    writeMigrateChoice(pageKey, next);
    setChoice(next);
  };

  const goNew = () => {
    // 带上来处：新版那边要知道「这个人是从旧版过来的」，
    // 才好把对照关系说清楚，而不是默认他已经懂了。
    navigate(`/e/${entry.key}?from=legacy`);
  };

  if (choice === 'never') return null;

  if (choice === 'later') {
    return (
      <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          这一页有可视化查询版，可以自己换维度、加筛选
        </Typography.Text>
        <Button type="link" size="small" onClick={goNew}>
          去看
        </Button>
        <Button type="text" size="small" onClick={() => choose('never')}>
          不再提示
        </Button>
      </div>
    );
  }

  return (
    <Alert
      type="info"
      showIcon
      style={{ marginBottom: 12 }}
      message={`「${entry.legacyPage?.title ?? entry.title}」已有可视化查询版`}
      description={
        <Space direction="vertical" size={6} style={{ width: '100%' }}>
          <Typography.Text style={{ fontSize: 13 }}>
            {entry.note || '同一份数据，可以自己换维度、加筛选、看环比，不再受固定表头限制。'}
          </Typography.Text>
          <Space size={6}>
            <Button type="primary" size="small" onClick={goNew}>
              立即体验
              <ArrowRightOutlined />
            </Button>
            <Button size="small" onClick={() => choose('later')}>
              以后再说
            </Button>
            <Button type="text" size="small" onClick={() => choose('never')}>
              不再提示
            </Button>
          </Space>
        </Space>
      }
    />
  );
}
