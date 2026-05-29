import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:7878',
      '/ws': { ws: true, target: 'ws://localhost:7878' }
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
});
