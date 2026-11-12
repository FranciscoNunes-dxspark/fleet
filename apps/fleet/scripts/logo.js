// Draws Fleet's mark: a command line, three prompts (>) one under another, each with what was typed
// after it, shorter each time, and the last only the cursor. It's drawn the way Keel's mark is, flat
// shapes on a graphite tile. Green, a terminal's colour, is one no mark beside it on a taskbar uses
// (Keel's is blue). One drawing,
// written to:
//   assets/logo.svg, logo.png (512 px)          the README
//   assets/logo.ico                              the Windows executable and its shortcuts (the kit's
//                                                scripts/build.js and installer/Fleet.iss)
//   ../../desktop/src-tauri/icons/*              the desktop window's icons, its installer's and shortcuts'
//   ../../desktop/ui/mark.svg                    the mark in the desktop window's top bar
// Don't edit those by hand: run
//   node scripts/logo.js
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

// Each shape's two tones, the deeper one `above` its cut; a shape with no cut is its `below` tone.
const tone = (hex) => ({ above: hex, below: hex });
const PROMPT = tone('#5fd787');
const TYPED = tone('#2e9e5b');
const CURSOR = tone('#ffffff');

/** A prompt's chevron: `x` its back, `cy` its middle, `h` half its height, `w` an arm's width, `d` how far its point leads. */
const chevron = (x, cy, h, w, d) => [[x, cy - h], [x + w, cy - h], [x + w + d, cy], [x + w, cy + h], [x, cy + h], [x + d, cy]];
const rect = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];

export const MARK = {
  size: 64,
  tile: { radius: 13, fill: '#16181d' },
  /** How tall each cut is. */
  gap: 3,
  // Three lines 14 apart, each 8 high: a prompt, then what was typed, the last line only the cursor.
  shapes: [
    { points: chevron(12, 18, 5, 5, 5), cut: null, colours: PROMPT },
    { points: rect(28, 14, 24, 8), cut: null, colours: TYPED },
    { points: chevron(12, 32, 5, 5, 5), cut: null, colours: PROMPT },
    { points: rect(28, 28, 16, 8), cut: null, colours: TYPED },
    { points: chevron(12, 46, 5, 5, 5), cut: null, colours: PROMPT },
    { points: rect(28, 42, 9, 8), cut: null, colours: CURSOR },
  ],
};

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

const inRound = (x, y, { x: rx, y: ry, w, h, r }) => {
  if (x < rx || y < ry || x > rx + w || y > ry + h) return false;
  const dx = Math.max(rx + r - x, x - (rx + w - r), 0);
  const dy = Math.max(ry + r - y, y - (ry + h - r), 0);
  return dx * dx + dy * dy <= r * r;
};

const inPolygon = (x, y, points) => {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

const inRing = (x, y, { cx, cy, inner, outer, from = 0, to = 360 }) => {
  const d = Math.hypot(x - cx, y - cy);
  if (d < inner || d > outer) return false;
  const a = ((Math.atan2(y - cy, x - cx) * 180) / Math.PI + 360) % 360;
  return a >= from && a <= to;
};

/** The mark as RGBA rows, `size` pixels square, on its rounded tile (`tile: false` for none), 4×4 samples a pixel. */
function markRows(size, { tile = true } = {}) {
  const S = MARK.size;
  const tileShape = { x: 0, y: 0, w: S, h: S, r: MARK.tile.radius };
  const onTile = (u, v) => (tile && inRound(u, v, tileShape) ? rgb(MARK.tile.fill) : null);
  const sample = (u, v) => {
    // In a shape's cut there's only the tile; either side of it, the shape's two tones.
    for (const shape of MARK.shapes) {
      if (!(shape.ring ? inRing(u, v, shape.ring) : inPolygon(u, v, shape.points))) continue;
      if (shape.cut == null) return rgb(shape.colours.below);
      if (v >= shape.cut && v < shape.cut + MARK.gap) return onTile(u, v);
      return rgb(shape.colours[v < shape.cut ? 'above' : 'below']);
    }
    return onTile(u, v);
  };
  const N = 4;
  return Array.from({ length: size }, (_, y) => {
    const row = Buffer.alloc(size * 4);
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < N; sy++) {
        for (let sx = 0; sx < N; sx++) {
          const c = sample(((x + (sx + 0.5) / N) * S) / size, ((y + (sy + 0.5) / N) * S) / size);
          if (!c) continue;
          r += c[0];
          g += c[1];
          b += c[2];
          a += 1;
        }
      }
      if (a) row.set([Math.round(r / a), Math.round(g / a), Math.round(b / a), Math.round((a / (N * N)) * 255)], x * 4);
    }
    return row;
  });
}

/** The mark as SVG: each shape clipped either side of its own cut. */
export function markSvg({ tile = true, title = 'Fleet' } = {}) {
  const { size: S, gap, shapes } = MARK;
  // A ring is two circles with the inner one cut out (evenodd); an arc of one, its two edges joined.
  const circle = (cx, cy, r) => `M${cx - r} ${cy} a${r} ${r} 0 1 0 ${2 * r} 0 a${r} ${r} 0 1 0 ${-2 * r} 0 Z`;
  const pt = (cx, cy, r, deg) => [cx + r * Math.cos((deg * Math.PI) / 180), cy + r * Math.sin((deg * Math.PI) / 180)].map((n) => +n.toFixed(3)).join(' ');
  const arcPath = ({ cx, cy, inner, outer, from, to }) => {
    const big = to - from > 180 ? 1 : 0;
    return `M${pt(cx, cy, outer, from)} A${outer} ${outer} 0 ${big} 1 ${pt(cx, cy, outer, to)} L${pt(cx, cy, inner, to)} A${inner} ${inner} 0 ${big} 0 ${pt(cx, cy, inner, from)} Z`;
  };
  const path = (s, fill) =>
    s.ring?.from != null
      ? `<path d="${arcPath(s.ring)}" fill="${fill}"/>`
      : s.ring
      ? `<path d="${circle(s.ring.cx, s.ring.cy, s.ring.outer)} ${circle(s.ring.cx, s.ring.cy, s.ring.inner)}" fill-rule="evenodd" fill="${fill}"/>`
      : `<path d="M${s.points.map(([x, y]) => `${x} ${y}`).join(' L')} Z" fill="${fill}"/>`;
  const cuts = [...new Set(shapes.map((s) => s.cut).filter((cut) => cut != null))];
  const clips = cuts.map((cut) => `<clipPath id="above-${cut}"><rect width="${S}" height="${cut}"/></clipPath><clipPath id="below-${cut}"><rect y="${cut + gap}" width="${S}" height="${S - cut - gap}"/></clipPath>`).join('');
  const drawn = shapes.map((s) => s.cut == null ? path(s, s.colours.below) : `<g clip-path="url(#above-${s.cut})">${path(s, s.colours.above)}</g><g clip-path="url(#below-${s.cut})">${path(s, s.colours.below)}</g>`).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}">
<title>${title}</title>
<defs>${clips}</defs>
${tile ? `<rect width="${S}" height="${S}" rx="${MARK.tile.radius}" fill="${MARK.tile.fill}"/>\n` : ''}${drawn}
</svg>
`;
}

function png(rows) {
  const raw = Buffer.concat(rows.map((r) => Buffer.concat([Buffer.from([0]), r])));
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(rows[0].length / 4, 0);
  head.writeUInt32BE(rows.length, 4);
  head.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', head), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// A 32-bit bitmap for the .ico: BITMAPINFOHEADER, BGRA rows bottom-up, then the 1-bit mask.
function dib(rows) {
  const w = rows[0].length / 4;
  const h = rows.length;
  const maskRow = Math.ceil(w / 32) * 4;
  const head = Buffer.alloc(40);
  head.writeUInt32LE(40, 0);
  head.writeInt32LE(w, 4);
  head.writeInt32LE(h * 2, 8);
  head.writeUInt16LE(1, 12);
  head.writeUInt16LE(32, 14);
  head.writeUInt32LE(w * h * 4 + maskRow * h, 20);
  const pixels = Buffer.alloc(w * h * 4);
  const mask = Buffer.alloc(maskRow * h);
  for (let y = 0; y < h; y++) {
    const src = rows[h - 1 - y];
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = src.subarray(x * 4, x * 4 + 4);
      pixels.set([b, g, r, a], (y * w + x) * 4);
      if (a === 0) mask[y * maskRow + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return Buffer.concat([head, pixels, mask]);
}

// Bitmaps up to 128 px and a PNG at 256, the usual layout.
function ico(sizes) {
  const images = sizes.map((s) => (s >= 256 ? png(markRows(s)) : dib(markRows(s))));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map((img, i) => {
    const e = Buffer.alloc(16);
    e[0] = sizes[i] >= 256 ? 0 : sizes[i];
    e[1] = sizes[i] >= 256 ? 0 : sizes[i];
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(img.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += img.length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...images]);
}

const out = (path, data) => {
  const url = new URL(path, new URL('../', import.meta.url));
  mkdirSync(new URL('./', url), { recursive: true });
  writeFileSync(url, data);
};

const icon = ico([16, 24, 32, 48, 64, 128, 256]);
out('assets/logo.svg', markSvg());
out('assets/logo.png', png(markRows(512)));
out('assets/logo.ico', icon);
out('../../desktop/src-tauri/icons/32x32.png', png(markRows(32)));
out('../../desktop/src-tauri/icons/128x128.png', png(markRows(128)));
out('../../desktop/src-tauri/icons/128x128@2x.png', png(markRows(256)));
out('../../desktop/src-tauri/icons/icon.png', png(markRows(512)));
out('../../desktop/src-tauri/icons/icon.ico', icon);
out('../../desktop/ui/mark.svg', markSvg());
console.log('assets/logo.svg, logo.png, logo.ico; desktop/src-tauri/icons/*, desktop/ui/mark.svg');
