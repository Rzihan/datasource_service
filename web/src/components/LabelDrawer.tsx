import { useEffect, useState } from 'react';
import { App, Button, Drawer, Form, Input, Space, Switch, Typography } from 'antd';
import { createLabel, updateLabel } from '../api';
import type { GlobalLabel } from '../types';

interface Props {
  open: boolean;
  record: GlobalLabel | null; // null 表示新建
  onClose: () => void;
  onSaved: () => void;
}

export default function LabelDrawer({ open, record, onClose, onSaved }: Props) {
  const { message } = App.useApp();
  const [saving, setSaving] = useState(false);
  const [fieldKey, setFieldKey] = useState('');
  const [label, setLabel] = useState('');
  const [enabled, setEnabled] = useState(true);

  // field_key 在编辑态不可改：它是业务主键，被所有数据集的 dim_map / mtx_map 引用，
  // 原地改名会让引用它的字段在没人知情的情况下换名字。
  const isEdit = record !== null;

  useEffect(() => {
    if (!open) return;
    if (record) {
      setFieldKey(record.field_key);
      setLabel(record.label);
      setEnabled(record.status === 1);
    } else {
      setFieldKey('');
      setLabel('');
      setEnabled(true);
    }
  }, [open, record]);

  const submit = async () => {
    const key = fieldKey.trim();
    const text = label.trim();
    if (!key || !text) {
      message.warning('字段名与中文名都不能为空');
      return;
    }
    setSaving(true);
    try {
      if (record) {
        await updateLabel(record.field_key, { label: text, status: enabled ? 1 : 0, version: record.version });
      } else {
        await createLabel({ field_key: key.toLowerCase(), label: text, status: enabled ? 1 : 0 });
      }
      message.success('已保存');
      onSaved();
    } catch (e) {
      message.error((e as Error).message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={520}
      title={isEdit ? `编辑字段名称：${record.field_key}` : '新建字段名称'}
      destroyOnHidden
      footer={
        <Space style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" loading={saving} onClick={() => void submit()}>
            保存
          </Button>
        </Space>
      }
    >
      <Form layout="vertical">
        <Form.Item
          label="field_key"
          extra={
            isEdit
              ? '业务主键，不可修改'
              : '数据集 dim_map / mtx_map 里的键。统一小写：库与查询都是大小写不敏感的'
          }
        >
          <Input
            value={fieldKey}
            disabled={isEdit}
            placeholder="例如 cost"
            onChange={(e) => setFieldKey(e.target.value)}
          />
        </Form.Item>
        <Form.Item label="中文名" extra="对所有数据集生效；单个数据集可以在自己的 label_map 里覆盖">
          <Input value={label} placeholder="例如 消耗" onChange={(e) => setLabel(e.target.value)} />
        </Form.Item>
        <Form.Item label="状态" extra="停用等同于不存在，引用该字段的数据集会退回显示字段名本身">
          <Switch checked={enabled} onChange={setEnabled} checkedChildren="启用" unCheckedChildren="停用" />
        </Form.Item>
        {isEdit && (
          <Typography.Text type="secondary">
            当前版本 {record.version}，保存时带上版本号做乐观锁，冲突会提示重新加载
          </Typography.Text>
        )}
      </Form>
    </Drawer>
  );
}
