import { useEffect, useState } from 'react';
import { App, Button, Drawer, Form, Input, Space, Switch, Typography } from 'antd';
import SqlEditor from './SqlEditor';
import StringMapEditor from './StringMapEditor';
import { createDatasource, updateDatasource } from '../api';
import type { DatasourceConfig, StringMap } from '../types';

interface Props {
  open: boolean;
  record: DatasourceConfig | null; // null 表示新建
  onClose: () => void;
  onSaved: () => void;
}

export default function EditDrawer({ open, record, onClose, onSaved }: Props) {
  const { message } = App.useApp();
  const [saving, setSaving] = useState(false);

  // datasource_key 在编辑态不可修改：它是全局业务主键，被下游引用，
  // 改名等于换了一条配置。真要改名应当新建 + 停用旧的。
  const isEdit = record !== null;

  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [midSQL, setMidSQL] = useState('');
  const [dimMap, setDimMap] = useState<StringMap>({});
  const [mtxMap, setMtxMap] = useState<StringMap>({});
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    if (!open) return;
    if (record) {
      setKey(record.datasource_key);
      setName(record.datasource_name);
      setMidSQL(record.mid_sql);
      setDimMap(record.dim_map ?? {});
      setMtxMap(record.mtx_map ?? {});
      setEnabled(record.status === 1);
    } else {
      setKey('');
      setName('');
      setMidSQL('');
      setDimMap({});
      setMtxMap({});
      setEnabled(true);
    }
  }, [open, record]);

  const save = async () => {
    if (!key.trim()) {
      message.warning('请填写 datasource_key');
      return;
    }
    if (!name.trim()) {
      message.warning('请填写 datasource_name');
      return;
    }
    if (!midSQL.trim()) {
      message.warning('请填写 mid_sql');
      return;
    }
    setSaving(true);
    try {
      if (isEdit && record) {
        await updateDatasource(record.datasource_key, {
          datasource_name: name.trim(),
          mid_sql: midSQL,
          dim_map: dimMap,
          mtx_map: mtxMap,
          status: enabled ? 1 : 0,
          version: record.version,
        });
        message.success('已保存');
      } else {
        await createDatasource({
          datasource_key: key.trim().toLowerCase(),
          datasource_name: name.trim(),
          mid_sql: midSQL,
          dim_map: dimMap,
          mtx_map: mtxMap,
          status: enabled ? 1 : 0,
        });
        message.success('已创建');
      }
      onSaved();
    } catch (e) {
      const msg = (e as Error).message || '保存失败';
      if (msg.includes('version conflict')) {
        message.error('该配置已被他人修改，请刷新后重新编辑');
      } else {
        message.error(msg);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={900}
      title={isEdit ? `编辑 ${record?.datasource_key ?? ''}` : '新建 datasource'}
      destroyOnClose
      extra={
        <Space>
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" loading={saving} onClick={save}>
            保存
          </Button>
        </Space>
      }
    >
      <Form layout="vertical">
        <Form.Item
          label="datasource_key"
          required
          extra={
            isEdit
              ? '全局唯一，创建后不可修改（如需改名请新建配置并停用旧的）'
              : '全局唯一，仅允许小写字母、数字、下划线、短横线、点号'
          }
        >
          <Input
            value={key}
            disabled={isEdit}
            placeholder="例如 order_daily"
            onChange={(e) => setKey(e.target.value)}
          />
        </Form.Item>

        <Form.Item label="datasource_name" required>
          <Input value={name} placeholder="例如 订单日报" onChange={(e) => setName(e.target.value)} />
        </Form.Item>

        <Form.Item label="status">
          <Space>
            <Switch checked={enabled} onChange={setEnabled} checkedChildren="启用" unCheckedChildren="停用" />
            <Typography.Text type="secondary">停用的配置不会被下游加载</Typography.Text>
          </Space>
        </Form.Item>

        <Form.Item
          label={
            <Space>
              <span>mid_sql</span>
              <Typography.Text type="secondary">
                纯文本存储，不做语法校验 · {midSQL.length} 字符 / {new Blob([midSQL]).size} 字节
              </Typography.Text>
            </Space>
          }
          required
        >
          <SqlEditor value={midSQL} onChange={setMidSQL} />
        </Form.Item>

        <Form.Item label="dim_map" extra="map[string]string，可用表格或 JSON 两种方式编辑">
          <StringMapEditor
            value={dimMap}
            onChange={setDimMap}
            placeholderKey="维度名，例如 city"
            placeholderValue="映射表达式，例如 city_code"
          />
        </Form.Item>

        <Form.Item label="mtx_map" extra="map[string]string，可用表格或 JSON 两种方式编辑">
          <StringMapEditor
            value={mtxMap}
            onChange={setMtxMap}
            placeholderKey="指标名，例如 cost"
            placeholderValue="聚合表达式，例如 sum(stat_cost)"
          />
        </Form.Item>
      </Form>
    </Drawer>
  );
}
