// What a built file is made of, from its source map: each generated span belongs to the source its
// mapping names, so the bytes of each source in the output can be counted (as source-map-explorer
// does). This is how Ballast sees inside an output folder with no stats file, and inside a Vite build
// it ran itself with --sourcemap. Pure.

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const VALUE = new Map([...B64].map((c, i) => [c, i]));

/** One mapping segment's fields (base64 VLQ, each relative to the one before): [column, source?, line?, column?, name?]. */
export function decodeSegment(seg) {
  const out = [];
  let value = 0;
  let shift = 0;
  for (const c of seg) {
    const digit = VALUE.get(c);
    if (digit === undefined) return out;
    value += (digit & 31) << shift;
    if (digit & 32) shift += 5;
    else {
      out.push(value & 1 ? -(value >>> 1) : value >>> 1);
      value = 0;
      shift = 0;
    }
  }
  return out;
}

export const UNMAPPED = '[unmapped]';

/**
 * Map source → characters of `code` it accounts for, by the map's `mappings` (`sourceRoot` put in front
 * of each source). A span no mapping names (a bundler's own glue, newlines between) is UNMAPPED. Index
 * maps (`sections`) aren't read: null.
 */
export function sourceSizes(map, code) {
  if (!map || map.sections || typeof map.mappings !== 'string') return null;
  const sources = (map.sources ?? []).map((s) => `${map.sourceRoot ?? ''}${s ?? ''}`);
  const out = new Map();
  const add = (key, n) => n > 0 && out.set(key, (out.get(key) ?? 0) + n);
  const lines = String(code).split('\n');
  const mapped = map.mappings.split(';');
  let source = 0;
  for (let l = 0; l < lines.length; l++) {
    const length = lines[l].length + (l < lines.length - 1 ? 1 : 0);
    const segs = [];
    let column = 0;
    for (const seg of (mapped[l] ?? '').split(',')) {
      if (!seg) continue;
      const v = decodeSegment(seg);
      if (!v.length) continue;
      column += v[0];
      // The source index runs on across lines; the generated column starts again on each.
      if (v.length >= 4) source += v[1];
      segs.push([column, v.length >= 4 ? source : -1]);
    }
    if (!segs.length) {
      add(UNMAPPED, length);
      continue;
    }
    add(UNMAPPED, Math.min(segs[0][0], length));
    for (let i = 0; i < segs.length; i++) {
      const from = Math.min(segs[i][0], length);
      const to = Math.min(i + 1 < segs.length ? segs[i + 1][0] : length, length);
      add(segs[i][1] < 0 ? UNMAPPED : (sources[segs[i][1]] ?? UNMAPPED), to - from);
    }
  }
  return out;
}

/** The map a built file names in its last sourceMappingURL comment (a file beside it, not a data: URL), or null. */
export function mapUrlOf(code) {
  const m = /[#@]\s*sourceMappingURL=(\S+)\s*(?:\*\/)?\s*$/.exec(String(code).slice(-500));
  if (!m || m[1].startsWith('data:')) return null;
  return m[1];
}
