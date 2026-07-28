import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * dev: Vite(5173)에서 /api를 오케스트레이터(4000)로 프록시 → CORS 회피.
 * 데모/prod: 오케스트레이터가 dist/를 정적 서빙(같은 오리진)하므로 프론트는 상대경로만 쓴다.
 * seller /slot(결과 unlock)은 D-3 범위라 여기서 프록시하지 않는다.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:4000', changeOrigin: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
