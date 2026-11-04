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

// A base64 digit's value by character code, -1 for a character that isn't one.
const DIGIT = new Int8Array(128).fill(-1);
for (let i = 0; i < B64.length; i++) DIGIT[B64.charCodeAt(i)] = i;
const COMMA = 44;
const SEMICOLON = 59;

const grow = (a) => {
  const b = new Float64Array(a.length * 2);
  b.set(a);
  return b;
};

/**
 * Map source → characters of `code` it accounts for, by the map's `mappings` (`sourceRoot` put in front
 * of each source). A span no mapping names (a bundler's own glue, newlines between) is UNMAPPED. Index
 * maps (`sections`) aren't read: null.
 *
 * `mappings` is read in one pass, a character at a time, each segment as decodeSegment reads it: split
 * into lines and segments, each decoded into an array of its own, a 20 MB map took 1.5 s. The counts go
 * to a slot a key (sources named alike share one), and the Map is made at the end in the order a key
 * was first counted, as adding to it on the way did.
 */
export function sourceSizes(map, code) {
  if (!map || map.sections || typeof map.mappings !== 'string') return null;
  const keyId = new Map();
  const keys = [];
  const idOf = (key) => {
    let id = keyId.get(key);
    if (id === undefined) keyId.set(key, (id = keys.push(key) - 1));
    return id;
  };
  const unmapped = idOf(UNMAPPED);
  const sourceIds = (map.sources ?? []).map((s) => idOf(`${map.sourceRoot ?? ''}${s ?? ''}`));
  const counts = new Float64Array(keys.length);
  const firstAt = new Float64Array(keys.length).fill(Infinity);
  let order = 0;
  const add = (id, n) => {
    if (n <= 0) return;
    if (firstAt[id] === Infinity) firstAt[id] = order++;
    counts[id] += n;
  };
  const text = String(code);
  const mappings = map.mappings;
  const end = mappings.length;
  // The segments of the line being read: generated column, and source (-1 for none).
  let cols = new Float64Array(1024);
  let srcs = new Float64Array(1024);
  let at = 0;
  let source = 0;
  let lineStart = 0;
  while (lineStart <= text.length) {
    const nl = text.indexOf('\n', lineStart);
    const length = nl < 0 ? text.length - lineStart : nl - lineStart + 1;
    lineStart = nl < 0 ? text.length + 1 : nl + 1;
    // This line's segments, up to the next ; (none once the mappings have run out).
    let n = 0;
    let column = 0;
    while (at < end) {
      const c = mappings.charCodeAt(at);
      if (c === SEMICOLON) {
        at++;
        break;
      }
      if (c === COMMA) {
        at++;
        continue;
      }
      // One segment's fields, until a , or ; or a character that isn't base64 (which ends its reading).
      let fields = 0;
      let f0 = 0;
      let f1 = 0;
      let value = 0;
      let shift = 0;
      while (at < end) {
        const ch = mappings.charCodeAt(at);
        const digit = ch < 128 ? DIGIT[ch] : -1;
        if (digit < 0) break;
        at++;
        value += (digit & 31) << shift;
        if (digit & 32) shift += 5;
        else {
          const v = value & 1 ? -(value >>> 1) : value >>> 1;
          if (fields === 0) f0 = v;
          else if (fields === 1) f1 = v;
          fields++;
          value = 0;
          shift = 0;
        }
      }
      while (at < end) {
        const ch = mappings.charCodeAt(at);
        if (ch === COMMA || ch === SEMICOLON) break;
        at++;
      }
      if (!fields) continue;
      column += f0;
      // The source index runs on across lines; the generated column starts again on each.
      if (fields >= 4) source += f1;
      if (n === cols.length) {
        cols = grow(cols);
        srcs = grow(srcs);
      }
      cols[n] = column;
      srcs[n] = fields >= 4 ? source : -1;
      n++;
    }
    if (!n) {
      add(unmapped, length);
      continue;
    }
    add(unmapped, Math.min(cols[0], length));
    for (let i = 0; i < n; i++) {
      const from = Math.min(cols[i], length);
      const to = Math.min(i + 1 < n ? cols[i + 1] : length, length);
      const s = srcs[i];
      add(s < 0 || s >= sourceIds.length ? unmapped : sourceIds[s], to - from);
    }
  }
  const out = new Map();
  const counted = [...keys.keys()].filter((id) => firstAt[id] !== Infinity).sort((a, b) => firstAt[a] - firstAt[b]);
  for (const id of counted) out.set(keys[id], counts[id]);
  return out;
}

/** The map a built file names in its last sourceMappingURL comment (a file beside it, not a data: URL), or null. */
export function mapUrlOf(code) {
  const m = /[#@]\s*sourceMappingURL=(\S+)\s*(?:\*\/)?\s*$/.exec(String(code).slice(-500));
  if (!m || m[1].startsWith('data:')) return null;
  return m[1];
}
