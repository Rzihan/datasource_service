import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 构建产物直接输出到 internal/web/dist，由 Go 通过 go:embed 打进二进制，
// 部署时只需一个容器、一个端口。
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../internal/web/dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 4096, // monaco 体积大是预期内的
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: true,
      },
    },
  },
});
