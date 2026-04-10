import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/outreach/',
  server: {
    port: 5173,
    proxy: {
      '/outreach/api': {
        target: 'http://localhost:3105',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/outreach/, ''),
      },
      '/outreach/t': {
        target: 'http://localhost:3105',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/outreach/, ''),
      },
    },
  },
  build: {
    outDir: '../public',
    emptyOutDir: true,
  },
});
