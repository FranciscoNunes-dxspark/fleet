import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Every build gets its own id: the page carries it (__KEEL_BUILD__) and the server serves it as
// /build.json, so an open Keel can tell a new version is out and offer to update (client/src/version.js).
const build = `${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 8)}`;
const buildId = {
  name: 'keel-build-id',
  apply: 'build',
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'build.json', source: JSON.stringify({ build }) });
  },
};

export default defineConfig({
  root: 'client',
  plugins: [react(), buildId],
  define: { __KEEL_BUILD__: JSON.stringify(build) },
  build: { outDir: '../dist', emptyOutDir: true },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': `http://127.0.0.1:${process.env.API_PORT || 4280}` },
  },
});
