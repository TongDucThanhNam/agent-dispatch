import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The hub serves the build from a token path (`/<token>/`), so every URL in the
// output is relative. `bun run dev` proxies the API to the dev hub
// (scripts/dev-dashboard.ts on 127.0.0.1:4780), which refuses Stop and Retry.
const DEV_HUB = 'http://127.0.0.1:4780';
const DEV_TOKEN = 'de00'.repeat(12);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: './',
  worker: { format: 'es' },
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  build: {
    outDir: path.resolve(import.meta.dirname, '../assets/web/dashboard'),
    emptyOutDir: true,
    modulePreload: { polyfill: false },
    // The hub's CSP allows fonts and images from itself only, so nothing is inlined as a data: URL.
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 600,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api/': {
        target: DEV_HUB,
        changeOrigin: true,
        rewrite: (url) => url.replace(/^\/api\//, `/${DEV_TOKEN}/`),
        configure: (proxy) => proxy.on('proxyReq', (req) => { if (req.getHeader('origin')) req.setHeader('origin', DEV_HUB); }),
      },
    },
  },
});
