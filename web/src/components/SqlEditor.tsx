import { Suspense, lazy } from 'react';
import { Skeleton } from 'antd';

const MonacoEditor = lazy(() => import('./MonacoEditor'));

interface Props {
  value: string;
  onChange: (value: string) => void;
  height?: number;
}

// mid_sql 编辑器。只提供 SQL 语法高亮与行号，不做语法校验——
// 按约定后端对 mid_sql 内容不做任何校验，纯文本存储。
export default function SqlEditor({ value, onChange, height = 260 }: Props) {
  return (
    <div style={{ border: '1px solid #d9d9d9', borderRadius: 8, overflow: 'hidden' }}>
      <Suspense fallback={<Skeleton active paragraph={{ rows: 6 }} style={{ padding: 12, height }} />}>
        <MonacoEditor language="sql" value={value} onChange={onChange} height={height} />
      </Suspense>
    </div>
  );
}
