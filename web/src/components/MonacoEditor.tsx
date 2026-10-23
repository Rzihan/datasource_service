import Editor from '@monaco-editor/react';
import '../monaco-setup';

interface Props {
  language: 'sql' | 'json';
  value: string;
  onChange: (value: string) => void;
  height?: number;
}

// 单独成模块，配合 React.lazy 使用：monaco 体积很大（gzip 约 1MB），
// 只有在打开编辑抽屉时才加载，首屏不必为它买单。
export default function MonacoEditor({ language, value, onChange, height = 260 }: Props) {
  return (
    <Editor
      height={`${height}px`}
      language={language}
      theme="vs"
      value={value}
      onChange={(v) => onChange(v ?? '')}
      options={{
        minimap: { enabled: false },
        fontSize: 13,
        wordWrap: 'on',
        scrollBeyondLastLine: false,
        automaticLayout: true,
        tabSize: 2,
        renderLineHighlight: 'line',
        smoothScrolling: true,
      }}
    />
  );
}
