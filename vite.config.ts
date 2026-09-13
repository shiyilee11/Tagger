import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  server: {
    // Tauri devUrl 必须始终指向当前项目，禁止自动切换到其他服务。
    port: 5173,
    strictPort: true,
  },
});
