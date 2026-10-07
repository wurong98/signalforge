import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readBuildInfo } from './src/server/version.ts';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  // 构建时写入版本，页面底部与服务端 /api/version 对比
  define: { __WEB_BUILD__: JSON.stringify({ ...readBuildInfo(), built_at: Date.now() }) },
  build: { outDir: '../dist/web', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false } },
  },
});
