import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: false,
    // The live preview is served through a proxied host, so accept any Host header.
    allowedHosts: true,
    cors: true,
    hmr: {
      // HMR travels over the same proxied origin as the page.
      clientPort: 443,
      protocol: 'wss',
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    allowedHosts: true,
  },
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 2000,
  },
});
