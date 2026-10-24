import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

// The /cli page runs the terminal app (cli/) and Ink in the browser. What they import from Node, and
// Ink's helpers for a real terminal process, become the stand-ins in client/src/cli/shims/; only that
// page's chunk loads them.
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const shim = (file) => path.join(ROOT, 'client/src/cli/shims', file);
const NODE = {
  process: 'process.js', events: 'events.js', stream: 'stream.js', buffer: 'buffer.js', fs: 'fs.js', path: 'path.js',
  os: 'misc.js', url: 'misc.js', util: 'misc.js', child_process: 'misc.js', 'readline/promises': 'misc.js',
};
// Packages that stand in through one export of misc.js (or a value) as their default.
const DEFAULTS = {
  'signal-exit': 'onExit', 'cli-cursor': 'cliCursor', 'patch-console': 'patchConsole', 'terminal-size': 'terminalSize',
  'stack-utils': 'StackUtils', 'is-in-ci': false, ws: {}, 'react-devtools-core': {}, 'bun:ffi': {},
};
// The terminal app's own modules that start programs: the page has its own.
const SWAPPED = new Map(['open.js', 'clipboard.js'].map((f) => [path.join(ROOT, 'cli', f), shim(f)]));
const cliInBrowser = {
  name: 'keel-cli-in-browser',
  enforce: 'pre',
  resolveId(source, importer) {
    const bare = source.replace(/^node:/, '');
    if (NODE[bare]) return shim(NODE[bare]);
    if (bare in DEFAULTS) return `\0keel-shim:${bare}`;
    if (importer && source.startsWith('.')) return SWAPPED.get(path.resolve(path.dirname(importer.split('?')[0]), source)) ?? null;
    return null;
  },
  load(id) {
    if (!id.startsWith('\0keel-shim:')) return null;
    const value = DEFAULTS[id.slice('\0keel-shim:'.length)];
    return typeof value === 'string' ? `export { ${value} as default } from ${JSON.stringify(shim('misc.js'))};` : `export default ${JSON.stringify(value)};`;
  },
};

export default defineConfig({
  root: 'client',
  plugins: [cliInBrowser, react(), buildId],
  define: { __KEEL_BUILD__: JSON.stringify(build) },
  build: { outDir: '../dist', emptyOutDir: true },
  // The dev server pre-bundles Ink too, so the stand-ins apply there as well.
  optimizeDeps: { rolldownOptions: { plugins: [cliInBrowser] } },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': `http://127.0.0.1:${process.env.API_PORT || 4280}` },
  },
});
