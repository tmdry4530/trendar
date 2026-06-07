import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 프론트는 상대경로 `/api/...`만 호출하고, dev 서버가 백엔드(4000)로 프록시한다.
// CLAUDE.md §4 규약.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
});
