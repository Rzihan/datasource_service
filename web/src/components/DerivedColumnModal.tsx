import { useEffect, useState } from 'react';
import { Alert, Divider, Input, Modal, Space, Tag, Typography } from 'antd';

interface Props {
  open: boolean;
  onClose: () => void;
  // 可用的列：本次查询返回的字段，label 是中文名
  fields: Array<{ name: string; label: string }>;
  onPreview: (expr: string) => { error: string; preview: string };
  onAdd: (name: string, expr: string) => void;
}

// 派生指标弹窗：写一个四则运算，生成一列新指标。
// 只允许引用「本次查询的列」——引用别的数据集的字段会得到一行 NULL，
// 那种错误在表里看不出来，不如在输入时就拒绝。
export default function DerivedColumnModal({ open, onClose, fields, onPreview, onAdd }: Props) {
  const [name, setName] = useState('');
  const [expr, setExpr] = useState('');
  const [error, setError] = useState('');
  const [preview, setPreview] = useState('');

  useEffect(() => {
    if (open) {
      setName('');
      setExpr('');
      setError('');
      setPreview('');
    }
  }, [open]);

  useEffect(() => {
    if (!expr.trim()) {
      setError('');
      setPreview('');
      return;
    }
    const r = onPreview(expr.trim());
    setError(r.error);
    setPreview(r.preview);
  }, [expr, onPreview]);

  const submit = () => {
    if (!name.trim()) {
      setError('给新列起个名字，例如 CPC');
      return;
    }
    const r = onPreview(expr.trim());
    if (r.error) {
      setError(r.error);
      return;
    }
    onAdd(name.trim(), expr.trim());
    onClose();
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      onOk={submit}
      okText="添加列"
      cancelText="取消"
      title="计算列（派生指标）"
      width={560}
      destroyOnHidden
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            列名
          </Typography.Text>
          <Input
            style={{ marginTop: 4 }}
            value={name}
            placeholder="例如 CPC"
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            表达式（支持 + - * / 和括号）
          </Typography.Text>
          <Input
            style={{ marginTop: 4, fontFamily: 'Menlo, monospace' }}
            value={expr}
            placeholder="例如 cost / clicks"
            onChange={(e) => setExpr(e.target.value)}
            onPressEnter={submit}
          />
          <div style={{ marginTop: 8 }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              点字段插入：
            </Typography.Text>
            <div style={{ marginTop: 4 }}>
              {fields.map((f) => (
                <Tag
                  key={f.name}
                  style={{ cursor: 'pointer', marginBottom: 4 }}
                  onClick={() => setExpr((prev) => (prev ? `${prev} ${f.name}` : f.name))}
                >
                  {f.label}
                  <Typography.Text type="secondary" style={{ fontSize: 11, marginLeft: 4 }}>
                    {f.name}
                  </Typography.Text>
                </Tag>
              ))}
            </div>
          </div>
        </div>

        {error ? (
          <Alert type="error" showIcon message={error} />
        ) : (
          preview && <Alert type="info" showIcon message={preview} />
        )}

        <Divider style={{ margin: '4px 0' }} />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          例子：<code>cost / clicks</code> 得到单次点击成本；
          <code>(cost - 0) / uv * 1000</code> 得到千次曝光成本。
          任一操作数为 NULL 或除以 0 时，该行结果为 NULL，不会当成 0。
        </Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          计算列只影响表格与导出的 CSV，不参与查询、也不进合计行。
        </Typography.Text>
      </Space>
    </Modal>
  );
}
