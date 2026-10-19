import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 프론트는 상대경로 `/api/...`만 호출하고, dev 서버가 백엔드(4000)로 프록시한다.
// 공개 SSR 경로(트렌드·레포·OG·배지·/ko·sitemap)도 백엔드가 렌더하므로 함께 프록시한다. `/`는 SPA 유지.
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
      '^/(trending|repo|og|badge)(?:[/?]|$)': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
      '^/ko(?:[/?]|$)': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
      '^/sitemap\\.xml(?:\\?|$)': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
});
