import { createRoot } from 'react-dom/client';
import { App as AntApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import App from './App';
// 注意：不要在这里引入 monaco-setup。它必须只在 MonacoEditor 内部被懒加载引用，
// 否则 monaco（gzip 约 1MB）会打进首屏 chunk，拖慢列表页打开速度。
import 'antd/dist/reset.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('#root not found');
}

createRoot(container).render(
  <ConfigProvider locale={zhCN}>
    <AntApp>
      <App />
    </AntApp>
  </ConfigProvider>,
);
