import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Built into the Python app's static folder; FastAPI serves index.html at "/".
export default defineConfig({
  plugins: [react()],
  base: '/static/cc/',
  build: { outDir: '../twin/static/cc', emptyOutDir: true, chunkSizeWarningLimit: 1500 },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8080', '/ws': { target: 'ws://127.0.0.1:8080', ws: true },
      '/video': 'http://127.0.0.1:8080', '/static/drones': 'http://127.0.0.1:8080', '/login': 'http://127.0.0.1:8080',
    },
  },
});
