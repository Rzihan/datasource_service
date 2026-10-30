import { useEffect, useState } from 'react';
import {
  Button,
  Drawer,
  Empty,
  Input,
  List,
  Modal,
  Popconfirm,
  Space,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { DeleteOutlined, EditOutlined, StarOutlined } from '@ant-design/icons';
import type { QueryDataset } from '../types';
import type { FavoriteEntry } from '../utils/favorites';
import { describeFilter } from '../utils/filterTree';

interface Props {
  open: boolean;
  onClose: () => void;
  favorites: FavoriteEntry[];
  datasets: QueryDataset[];
  // 当前这一屏命中的收藏：高亮出来，用户才知道「我存过、而且就是现在这个」
  activeId?: string;
  canSave: boolean;
  onSaveCurrent: () => void;
  onOpen: (f: FavoriteEntry) => void;
  onRename: (id: string, name: string, note: string) => void;
  onDelete: (id: string) => void;
  onClear: () => void;
}

// 用绝对时间而不是「3 天前」：收藏里躺着半年前的东西很正常，
// 相对时间在跨月后会变成没人看的噪音。
function favTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function FavoritesDrawer({
  open,
  onClose,
  favorites,
  datasets,
  activeId,
  canSave,
  onSaveCurrent,
  onOpen,
  onRename,
  onDelete,
  onClear,
}: Props) {
  const [editing, setEditing] = useState<FavoriteEntry | null>(null);
  const [name, setName] = useState('');
  const [note, setNote] = useState('');

  // 关抽屉时把编辑态一起收掉，下次打开是干净的
  useEffect(() => {
    if (!open) setEditing(null);
  }, [open]);

  const startEdit = (f: FavoriteEntry) => {
    setEditing(f);
    setName(f.name);
    setNote(f.note ?? '');
  };

  const submitEdit = () => {
    if (!editing) return;
    onRename(editing.id, name.trim() || editing.name, note.trim());
    setEditing(null);
  };

  const labelOf = (datasetKey: string) => (field: string) => {
    const ds = datasets.find((d) => d.dataset_key === datasetKey);
    return ds?.label_map?.[field] || field;
  };

  return (
    <Drawer
      title="收藏夹"
      width={520}
      open={open}
      onClose={onClose}
      extra={
        <Space size={8}>
          {favorites.length > 0 && (
            <Popconfirm title="清空全部收藏？" okText="清空" cancelText="取消" onConfirm={onClear}>
              <Button size="small" icon={<DeleteOutlined />}>
                清空
              </Button>
            </Popconfirm>
          )}
          <Tooltip title={canSave ? undefined : '先选一个数据集'}>
            <Button size="small" type="primary" icon={<StarOutlined />} disabled={!canSave} onClick={onSaveCurrent}>
              收藏当前
            </Button>
          </Tooltip>
        </Space>
      }
    >
      {favorites.length === 0 ? (
        <Empty
          description={
            <Space direction="vertical" size={4}>
              <Typography.Text>还没有收藏</Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                调好一张图后点「收藏当前」，起个名字，下次一点就回来
              </Typography.Text>
            </Space>
          }
        />
      ) : (
        <List
          size="small"
          dataSource={favorites}
          renderItem={(f) => {
            const ds = datasets.find((d) => d.dataset_key === f.datasetKey);
            const missing = !ds;
            const dimsText =
              f.dims.length > 0 ? f.dims.map((d) => labelOf(f.datasetKey)(d)).join('、') : '无维度';
            const mtxText =
              f.metrics.length > 0 ? f.metrics.map((m) => labelOf(f.datasetKey)(m)).join('、') : '无指标';
            const filterText = describeFilter(f.filterTree, labelOf(f.datasetKey));
            return (
              <List.Item
                style={f.id === activeId ? { background: 'rgba(24,144,255,0.06)' } : undefined}
                actions={[
                  <Button key="open" size="small" type="link" disabled={missing} onClick={() => onOpen(f)}>
                    打开
                  </Button>,
                  <Tooltip key="edit" title="改名 / 备注">
                    <Button size="small" type="text" icon={<EditOutlined />} onClick={() => startEdit(f)} />
                  </Tooltip>,
                  <Popconfirm
                    key="del"
                    title="删除这条收藏？"
                    okText="删除"
                    cancelText="取消"
                    onConfirm={() => onDelete(f.id)}
                  >
                    <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                  </Popconfirm>,
                ]}
              >
                <List.Item.Meta
                  title={
                    <Space size={6} wrap>
                      <span>{f.name}</span>
                      {f.id === activeId && <Tag color="blue">当前</Tag>}
                      {f.compare && <Tag color="purple">{f.compare.mode === 'prev_year' ? '同比' : '环比'}</Tag>}
                      {missing && <Tag color="red">数据集已不可见</Tag>}
                    </Space>
                  }
                  description={
                    <div style={{ fontSize: 12 }}>
                      <div>
                        {ds?.dataset_name ?? f.datasetKey} · {dimsText} × {mtxText}
                      </div>
                      {f.note && <div style={{ marginTop: 2 }}>{f.note}</div>}
                      {filterText && (
                        <Typography.Text type="secondary">筛选：{filterText}</Typography.Text>
                      )}
                      <div>
                        <Typography.Text type="secondary">
                          {favTime(f.ts)} · 上限 {f.limit}
                          {f.orderBy
                            ? ` · 按${labelOf(f.datasetKey)(f.orderBy.field)}${f.orderBy.desc ? '降序' : '升序'}`
                            : ''}
                        </Typography.Text>
                      </div>
                    </div>
                  }
                />
              </List.Item>
            );
          }}
        />
      )}

      <Modal
        title="改名 / 备注"
        open={!!editing}
        onOk={submitEdit}
        onCancel={() => setEditing(null)}
        okText="保存"
        cancelText="取消"
        destroyOnHidden
      >
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          <Input
            placeholder="收藏名，例如：采集日活周报"
            value={name}
            maxLength={40}
            onChange={(e) => setName(e.target.value)}
          />
          <Input.TextArea
            placeholder="备注：这张图用来看什么、什么时候看（可留空）"
            value={note}
            rows={3}
            maxLength={120}
            onChange={(e) => setNote(e.target.value)}
          />
        </Space>
      </Modal>
    </Drawer>
  );
}
