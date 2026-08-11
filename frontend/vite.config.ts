import path from 'path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

const isProd = process.env.NODE_ENV === 'production' || process.env.NETLIFY === 'true';
const basePath = isProd ? '/' : (process.env.BASE_PATH || '/');

let port = 5173;
if (!isProd) {
  const rawPort = process.env.PORT;
  if (rawPort) {
    const parsed = Number(rawPort);
    if (!isNaN(parsed) && parsed > 0) port = parsed;
  }
}

export default defineConfig({
  base: basePath,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
    dedupe: ['react', 'react-dom'],
  },
  root: __dirname,
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: `assets/[name]-[hash].js?v=${Date.now()}`,
        chunkFileNames: `assets/[name]-[hash].js?v=${Date.now()}`,
        assetFileNames: `assets/[name]-[hash].[ext]?v=${Date.now()}`,
      },
    },
  },
  server: {
    port,
    strictPort: true,
    host: '0.0.0.0',
    allowedHosts: true,
    fs: { strict: true },
    proxy: {
      '/api': {
        target: process.env.API_URL || 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  preview: {
    port,
    host: '0.0.0.0',
    allowedHosts: true,
  },
});
