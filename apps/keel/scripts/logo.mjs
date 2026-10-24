// Draws Pinch, Keel's crab, into every icon Keel ships, from the pixels in client/src/pinch.js,
// with a pixel-art Azure DevOps mark as a badge in the bottom-right corner, the way Tiller and
// Trawl badge theirs with Git and SQL:
//   assets/pinch.svg, pinch.png               the README and social preview
//   assets/pinch-transparent.svg, .png        just the crab and badge, for light pages and slides
//   assets/pinch.ico                           the terminal app's Windows executable
//   client/public/favicon.svg                 the browser tab and desktop notifications
//   client/public/icons/icon-192/512.png      the installed app
//   client/public/icons/apple-touch-icon.png  iOS Home Screen (opaque, iOS rounds the corners)
//   client/public/icons/maskable-512.png      Android adaptive icon, kept inside the safe circle
//   client/public/icons/badge-96.png          Android's status-bar badge: a white silhouette
//   node scripts/logo.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { BG, PALETTE, pinchPixels } from '../client/src/pinch.js';

const root = new URL('../', import.meta.url);
const out = (path, data) => {
  const url = new URL(path, root);
  mkdirSync(new URL('./', url), { recursive: true });
  writeFileSync(url, data);
};

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), 255];

// The Azure DevOps mark in white on its blue rounded square. It's drawn at twice Pinch's
// resolution, the coarsest the mark still reads at.
const COLOURS = { ...PALETTE, A: '#0078d4', S: '#ffffff' };
const ADO = [
  '.AAAAAAAAAAAAA.',
  'AAAAAAAAAAAAAAA',
  'AAAAAAAWAAAAAAA',
  'AAAAAAWWWAAAAAA',
  'AAAWWWWWWAWWAAA',
  'AAWWAAAAAAWWAAA',
  'AAWAAAAAAAWWAAA',
  'AAWAAAAAAAWWAAA',
  'AAWAAAAAAAWWAAA',
  'AAWWAAAAAAWWAAA',
  'AAAAWWWWWWWWAAA',
  'AAAAWWWWWWWWAAA',
  'AAAAAWAAWWAAAAA',
  'AAAAAAAAAAAAAAA',
  '.AAAAAAAAAAAAA.',
];

const px = pinchPixels();
// Pinch at the badge's resolution: every pixel doubled.
const px2 = px.flatMap((row) => {
  const wide = [...row].map((c) => c + c).join('');
  return [wide, wide];
});

/**
 * Pinch at (ox, oy) on a w × h grid of half-pixels, with the badge's top-left corner at (bx, by),
 * cut out of the crab by a one-cell gap. Rows of palette letters, '.' for nothing.
 */
function grid(w, h, ox, oy, bx, by) {
  const badge = (x, y) => ADO[y - by]?.[x - bx] ?? '.';
  return Array.from({ length: h }, (_, y) =>
    Array.from({ length: w }, (_, x) => {
      if (badge(x, y) !== '.') return badge(x, y);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (badge(x + dx, y + dy) !== '.') return '.';
      return px2[y - oy]?.[x - ox] ?? '.';
    }).join(''),
  );
}

// The crab and its badge as one drawing, laid out as in all the family's logos: the badge's
// bottom-right corner PAD half-pixels right of and below the crab's, so the badges sit alike.
const BW = ADO[0].length;
const BH = ADO.length;
const PAD = 4;
const GW = px2[0].length + PAD;
const GH = px2.length + PAD;
/** The crab and badge centred on a size × size square; wider than the square, the badge keeps to its edge. */
function square(size) {
  const ox = Math.max(0, Math.floor((size - GW) / 2));
  const oy = Math.max(0, Math.floor((size - GH) / 2));
  return grid(size, size, ox, oy, Math.min(ox + GW, size) - BW, Math.min(oy + GH, size) - BH);
}

// The dark square: 40 half-pixels across.
const SQUARE = square(40);
// iOS: 45 across, so 180 px keeps the pixels whole (4 each), with the same layout.
const APPLE = square(45);
// Android's maskable icon may be cropped to a circle of 80% of its width: 64 across leaves the
// badge's far corner just inside it, at 8 px a cell in 512.
const MASKABLE = square(64);
// The crab cropped to the drawing, with room right and below for the badge to sit on.
const CROPPED = grid(GW, GH, 0, 0, GW - BW, GH - BH);
// The notification badge: just the crab, undoubled, 4 px a pixel in 96, centred.
const BADGE = Array.from({ length: 24 }, (_, y) => Array.from({ length: 24 }, (_, x) => (px[y - 7]?.[x - 4] ?? '.') === '.' ? '.' : 'S').join(''));

/** A grid drawn at `scale` image pixels per cell, as RGBA rows; `inside(x, y)` limits it to a shape. */
function paint(cells, scale, bg = [0, 0, 0, 0], inside = () => true) {
  const rows = [];
  for (let y = 0; y < Math.round(cells.length * scale); y++) {
    const row = [];
    for (let x = 0; x < Math.round(cells[0].length * scale); x++) {
      const c = cells[Math.floor(y / scale)][Math.floor(x / scale)];
      row.push(...(!inside(x, y) ? [0, 0, 0, 0] : COLOURS[c] ? hex(COLOURS[c]) : bg));
    }
    rows.push(row);
  }
  return rows;
}

// The dark rounded square with the crab, as RGBA rows; transparent outside the corners.
function canvas(size) {
  const radius = size * 0.18;
  return paint(SQUARE, size / 40, hex(BG), (x, y) => {
    const cx = Math.max(radius - x, x - (size - 1 - radius), 0);
    const cy = Math.max(radius - y, y - (size - 1 - radius), 0);
    return cx * cx + cy * cy <= radius * radius;
  });
}

/** Encodes RGBA rows as a PNG. */
function png(rows) {
  const raw = Buffer.concat(rows.map((r) => Buffer.from([0, ...r])));
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
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
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(rows[0].length / 4, 0);
  ihdr.writeUInt32BE(rows.length, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// An uncompressed 32-bit icon image: BITMAPINFOHEADER, BGRA rows bottom-up, then the 1-bit
// transparency mask older readers use. Every program that reads .ico files reads these.
function dib(rows) {
  const w = rows[0].length / 4;
  const h = rows.length;
  const maskRow = Math.ceil(w / 32) * 4;
  const head = Buffer.alloc(40);
  head.writeUInt32LE(40, 0);
  head.writeInt32LE(w, 4);
  head.writeInt32LE(h * 2, 8); // colour rows plus mask rows
  head.writeUInt16LE(1, 12);
  head.writeUInt16LE(32, 14);
  head.writeUInt32LE(w * h * 4 + maskRow * h, 20);
  const pixels = Buffer.alloc(w * h * 4);
  const mask = Buffer.alloc(maskRow * h);
  for (let y = 0; y < h; y++) {
    const src = rows[h - 1 - y];
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = src.slice(x * 4, x * 4 + 4);
      pixels.set([b, g, r, a], (y * w + x) * 4);
      if (a === 0) mask[y * maskRow + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return Buffer.concat([head, pixels, mask]);
}

/**
 * An .ico with one image per size, Pinch on the dark square (as Trawl's has Glim): the Windows
 * executable's icon. Bitmaps up to 128 px and a PNG at 256, the usual layout: some readers can't
 * decode small PNGs.
 */
function ico(sizes) {
  const images = sizes.map((s) => (s >= 256 ? png(canvas(s)) : dib(canvas(s))));
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

/** The logo as SVG: on its dark rounded square, or with `background: false` just the crab, cropped. */
function svg({ background = true } = {}) {
  const cells = background ? SQUARE : CROPPED;
  const rects = [];
  cells.forEach((row, y) =>
    [...row].forEach((c, x) => {
      if (COLOURS[c]) rects.push(`<rect x="${x}" y="${y}" width="1.02" height="1.02" fill="${COLOURS[c]}"/>`);
    }),
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${cells[0].length} ${cells.length}" shape-rendering="crispEdges">
<title>Pinch, the Keel crab</title>
${background ? `<rect width="40" height="40" rx="7.2" fill="${BG}"/>\n` : ''}${rects.join('\n')}
</svg>
`;
}

out('assets/pinch.svg', svg());
out('assets/pinch.png', png(canvas(512)));
// 40 across is Pinch's square: 40, 80, 120 and 240 keep its pixels whole; the rest are the sizes Windows asks for.
out('assets/pinch.ico', ico([16, 24, 32, 40, 48, 64, 80, 128, 256]));
out('assets/pinch-transparent.svg', svg({ background: false }));
out('assets/pinch-transparent.png', png(paint(CROPPED, 16)));
out('client/public/favicon.svg', svg());
out('client/public/icons/icon-192.png', png(canvas(192)));
out('client/public/icons/icon-512.png', png(canvas(512)));
out('client/public/icons/apple-touch-icon.png', png(paint(APPLE, 4, hex(BG))));
out('client/public/icons/maskable-512.png', png(paint(MASKABLE, 8, hex(BG))));
out('client/public/icons/badge-96.png', png(paint(BADGE, 4)));
console.log('assets/pinch.svg, pinch.png, pinch.ico, pinch-transparent.svg, pinch-transparent.png; client/public/favicon.svg, icons/*.png');
