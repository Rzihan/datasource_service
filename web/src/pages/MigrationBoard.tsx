import { useEffect, useMemo, useState } from 'react';
import { App as AntApp, Button, Card, Progress, Select, Space, Table, Tag, Typography } from 'antd';
import type { QueryDataset } from '../types';
import { updateDatasetEntry } from '../api';
import { collectEntries, statusText } from '../utils/entries';
import { readVisits, subscribeMigration } from '../utils/migration';
import type { EntryItem } from '../utils/entries';

interface Props {
  datasets: QueryDataset[];
  onReload: () => void;
}

// 迁移看板：回答「现在能下线这个旧页了吗」。
//
// 没有这个看板，迁移的进度只能靠感觉：要么一直并存着不敢动，
// 要么某天一拍桌子把旧页删掉、然后被用户追着问。
// 有了「新版 / 旧版各被打开了多少次」，下线与否变成一个能讨论的数字。
export default function MigrationBoard({ datasets, onReload }: Props) {
  const { message } = AntApp.useApp();
  const entries = useMemo(() => collectEntries(datasets), [datasets]);
  const [visits, setVisits] = useState(readVisits);
  const [busyKey, setBusyKey] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);

  // 打开次数随时在变（用户正在别的标签页里点），进页面时和切换后都要刷新
  useEffect(() => subscribeMigration(() => setVisits(readVisits())), []);
  useEffect(() => setVisits(readVisits()), [datasets]);

  const rows: Array<{ entry: EntryItem; legacy: number; entryVisits: number }> = entries
    .filter((e) => e.legacy)
    .map((e) => {
      const v = visits[e.legacy ?? ''] ?? { legacy: 0, entry: 0 };
      return { entry: e, legacy: v.legacy, entryVisits: v.entry };
    });

  const totalLegacy = rows.reduce((s, r) => s + r.legacy, 0);
  const totalEntry = rows.reduce((s, r) => s + r.entryVisits, 0);
  const rate = totalLegacy + totalEntry > 0 ? Math.round((totalEntry / (totalLegacy + totalEntry)) * 100) : 0;

  const setStatus = async (e: EntryItem, status: 'parallel' | 'default' | 'replaced') => {
    setBusyKey(e.key);
    try {
      await updateDatasetEntry(e.datasetKey, { status });
      message.success(`「${e.legacyPage?.title ?? e.title}」→ ${statusText(status)}`);
      onReload();
    } catch (err) {
      message.error((err as Error).message || '切换失败');
    } finally {
      setBusyKey('');
    }
  };

  // 一键推进：把所有还在观察期的入口推到「默认走新版」。
  // 刻意不做成「一键下线」——观察期都没过的入口直接下线，是把风险一次性放大。
  const pushAll = async () => {
    const targets = rows.filter((r) => r.entry.status === 'parallel');
    if (targets.length === 0) {
      message.info('没有还在并存期的入口');
      return;
    }
    setBulkBusy(true);
    try {
      for (const r of targets) {
        await updateDatasetEntry(r.entry.datasetKey, { status: 'default' });
      }
      message.success(`${targets.length} 个入口已推进到「默认走新版」`);
      onReload();
    } catch (err) {
      message.error((err as Error).message || '推进失败');
    } finally {
      setBulkBusy(false);
    }
  };

  return (
    <Card
      size="small"
      title="迁移看板"
      extra={
        <Button size="small" loading={bulkBusy} onClick={() => void pushAll()}>
          把并存的推进到默认走新版
        </Button>
      }
    >
      <Space size={16} style={{ marginBottom: 12 }} wrap>
        <Typography.Text>
          入口 <b>{rows.length}</b> 个
        </Typography.Text>
        <Typography.Text>
          已下线 <b>{rows.filter((r) => r.entry.status === 'replaced').length}</b> 个
        </Typography.Text>
        <Space size={6}>
          <Typography.Text>整体迁移率</Typography.Text>
          <Progress percent={rate} size="small" style={{ width: 160, marginBottom: 0 }} />
        </Space>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          新版 {totalEntry} 次 · 旧版 {totalLegacy} 次
        </Typography.Text>
      </Space>
      <Table
        size="small"
        rowKey={(r) => r.entry.key}
        pagination={false}
        dataSource={rows}
        columns={[
          {
            title: '旧页面',
            dataIndex: ['entry', 'legacyPage', 'title'],
            render: (_v, r) => (
              <Space direction="vertical" size={0}>
                <Typography.Text>{r.entry.legacyPage?.title ?? r.entry.title}</Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {r.entry.module}
                </Typography.Text>
              </Space>
            ),
          },
          { title: '入口', dataIndex: ['entry', 'key'], render: (v: string) => <code>{v}</code> },
          {
            title: '新版 / 旧版',
            render: (_v, r) => (
              <Space size={6}>
                <Tag color={r.entryVisits > 0 ? 'green' : 'default'}>新 {r.entryVisits}</Tag>
                <Tag color={r.legacy > 0 ? 'orange' : 'default'}>旧 {r.legacy}</Tag>
              </Space>
            ),
          },
          {
            title: '迁移率',
            render: (_v, r) => {
              const total = r.legacy + r.entryVisits;
              if (total === 0) return <Typography.Text type="secondary">还没人打开</Typography.Text>;
              const p = Math.round((r.entryVisits / total) * 100);
              return <Progress percent={p} size="small" style={{ width: 120, marginBottom: 0 }} />;
            },
          },
          {
            title: '状态',
            render: (_v, r) => (
              <Select
                size="small"
                style={{ width: 150 }}
                value={r.entry.status}
                disabled={busyKey === r.entry.key}
                onChange={(v) => void setStatus(r.entry, v)}
                options={[
                  { value: 'parallel', label: statusText('parallel') },
                  { value: 'default', label: statusText('default') },
                  { value: 'replaced', label: statusText('replaced') },
                ]}
              />
            ),
          },
        ]}
      />
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 12, marginBottom: 0 }}>
        打开次数记在本机（这台环境没有埋点服务）。真实接入时这两个数应来自埋点并按人去重——
        看板的价值不在「多少」，而在「还有没有人在用旧页」。
      </Typography.Paragraph>
    </Card>
  );
}
