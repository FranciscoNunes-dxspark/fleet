// What a file weighs: as it is, and as a server sends it, gzip and brotli (node:zlib, at the levels a
// build's precompression or a CDN uses). And sizes as people write and read them: "180kB", "1.2 MB".
// Pure but for the compressing, which is CPU only.
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

// Brotli's best level is slow on a big file; above this, level 9 gives a size within a percent or two.
const BROTLI_BEST_UP_TO = 4 * 1024 * 1024;

/** { raw, gzip, brotli } in bytes for `content` (a Buffer or text). */
export function compressedSizes(content) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
  const quality = bytes.length <= BROTLI_BEST_UP_TO ? 11 : 9;
  return {
    raw: bytes.length,
    gzip: gzipSync(bytes, { level: 9 }).length,
    brotli: brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: quality, [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length } }).length,
  };
}

export const MEASURES = ['gzip', 'brotli', 'raw'];

const UNITS = { b: 1, k: 1000, kb: 1000, kib: 1024, m: 1000 ** 2, mb: 1000 ** 2, mib: 1024 ** 2 };

/** "180kB", "180 KB", "1.5MB", "200KiB", "4096" (bytes) → bytes; null when it isn't a size. kB is 1000 bytes, as build tools print it. */
export function parseSize(text) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([a-z]*)\s*$/i.exec(String(text ?? ''));
  if (!m) return null;
  const unit = UNITS[(m[2] || 'b').toLowerCase()];
  return unit ? Math.round(Number(m[1]) * unit) : null;
}

/** 1234 → "1.2 kB", 2345678 → "2.35 MB", as Vite and esbuild print sizes. */
export function formatBytes(n) {
  if (n == null || Number.isNaN(n)) return '?';
  const a = Math.abs(n);
  if (a < 1000) return `${n} B`;
  if (a < 1000 ** 2) return `${(n / 1000).toFixed(1)} kB`;
  return `${(n / 1000 ** 2).toFixed(2)} MB`;
}

/** A change in size with its sign: "+42.1 kB", "-3.0 kB", "±0 B". */
export const formatDelta = (n) => (n > 0 ? `+${formatBytes(n)}` : n < 0 ? `-${formatBytes(-n)}` : '±0 B');

/** The change as a share of what it was: "+13.2%", or '' when there was nothing before. */
export function formatPercent(delta, before) {
  if (!before) return '';
  const p = (delta / before) * 100;
  return `${p > 0 ? '+' : p < 0 ? '-' : '±'}${Math.abs(p).toFixed(1)}%`;
}

/** A chunk's (or a run's) size in `measure`, falling back to raw where it wasn't compressed (a file the stats name but the disk hasn't). */
export const sizeIn = (x, measure = 'gzip') => x?.[measure] ?? x?.raw ?? 0;
