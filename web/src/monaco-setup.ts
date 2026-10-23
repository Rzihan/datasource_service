// 按需引入 monaco：只要 SQL 高亮 + JSON 语言服务。
// 直接 `import * as monaco from 'monaco-editor'` 会把 abap/solidity/ruby 等几十种语言
// 全部打进包里（主 chunk 4.4MB），而这个项目根本用不到。
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import 'monaco-editor/esm/vs/editor/editor.all.js';
import 'monaco-editor/esm/vs/basic-languages/sql/sql.contribution.js';
import 'monaco-editor/esm/vs/language/json/monaco.contribution.js';
import { loader } from '@monaco-editor/react';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';

// 让 monaco 使用本地打包的 worker，而不是默认的 CDN 加载。
// 内网环境下 CDN 往往不可达，不配这一步编辑器会直接报错。
(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === 'json') {
      return new jsonWorker();
    }
    return new editorWorker();
  },
};

loader.config({ monaco });
