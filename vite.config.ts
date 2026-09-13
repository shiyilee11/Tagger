import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  server: {
    // Vite 开发服务器端口，需要和 tauri.conf.json 的 devUrl 一致
    port: 5173,
    strictPort: false,
  },
});