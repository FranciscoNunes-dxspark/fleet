// Draws Keel's icons. The web app's are the mark in client/src/mark.js, a K turned round into a
// prompt on a blue tile, each of its shapes cut across; the terminal app's are Pinch, Keel's crab, from the pixels
// in client/src/pinch.js, with a pixel-art Azure DevOps mark as a badge in the bottom-right corner,
// the way Tiller and Trawl badge theirs with Git and SQL:
//   assets/pinch.svg, pinch.png               the README and social preview
//   assets/pinch-transparent.svg, .png        just the crab and badge, for light pages and slides
//   assets/pinch.ico                           the terminal app's Windows executable
//   client/public/favicon.svg                 the mark: the browser tab and desktop notifications
//   client/public/icons/icon-192/512.png      the installed app
//   client/public/icons/apple-touch-icon.png  iOS Home Screen (opaque, iOS rounds the corners)
//   client/public/icons/maskable-512.png      Android adaptive icon, kept inside the safe circle
//   client/public/icons/badge-96.png          Android's status-bar badge: a white silhouette
//   node scripts/logo.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { BG, PALETTE, pinchPixels } from '../client/src/pinch.js';
import { MARK } from '../client/src/mark.js';

const root = new URL('../', import.meta.url);
const out = (path, data) => {
  const url = new URL(path, root);
  mkdirSync(new URL('./', url), { recursive: true });
  writeFileSync(url, data);
};

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), 255];

// The Azure DevOps mark in white on its blue rounded square. It's drawn at twice Pinch's
// resolution, the coarsest the mark still reads at.
const COLOURS = { ...PALETTE, A: '#0078d4' };
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
// The crab cropped to the drawing, with room right and below for the badge to sit on.
const CROPPED = grid(GW, GH, 0, 0, GW - BW, GH - BH);

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
// The web app's mark. Drawn from shapes rather than pixels, so each image samples every pixel at
// 4 × 4 points and blends what it hits: smooth edges at any size, with no dependency to render SVG.

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

/**
 * The mark as RGBA rows, `size` pixels square. `tile` is 'round' (transparent corners), 'square'
 * (opaque to the edge) or 'none'; `scale` shrinks the K about the centre (the maskable icon's safe
 * circle); `colour` paints the K in one colour (the notification badge's silhouette).
 */
function markRows(size, { tile = 'round', scale = 1, colour } = {}) {
  const S = MARK.size;
  const tileShape = { x: 0, y: 0, w: S, h: S, r: tile === 'round' ? MARK.tile.radius : 0 };
  const sample = (u, v) => {
    // The K's own coordinates: scaled about the centre.
    const gx = S / 2 + (u - S / 2) / scale;
    const gy = S / 2 + (v - S / 2) / scale;
    // Each shape has its own cut: nothing in it, its two tones either side.
    const paint = (shape) => {
      if (gy >= shape.cut && gy < shape.cut + MARK.gap) return null;
      return hex(colour || shape.colours[gy < shape.cut ? 'above' : 'below']);
    };
    if (inRound(gx, gy, MARK.bar)) return paint(MARK.bar) ?? (tile !== 'none' && inRound(u, v, tileShape) ? hex(MARK.tile.fill) : null);
    if (inPolygon(gx, gy, MARK.chevron.points)) return paint(MARK.chevron) ?? (tile !== 'none' && inRound(u, v, tileShape) ? hex(MARK.tile.fill) : null);
    if (tile !== 'none' && inRound(u, v, tileShape)) return hex(MARK.tile.fill);
    return null;
  };
  const N = 4;
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = [];
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < N; sy++) for (let sx = 0; sx < N; sx++) {
        const c = sample(((x + (sx + 0.5) / N) * S) / size, ((y + (sy + 0.5) / N) * S) / size);
        if (c) { r += c[0]; g += c[1]; b += c[2]; a += 1; }
      }
      row.push(...(a ? [Math.round(r / a), Math.round(g / a), Math.round(b / a), Math.round((a / (N * N)) * 255)] : [0, 0, 0, 0]));
    }
    rows.push(row);
  }
  return rows;
}

/** The mark as SVG, on its rounded tile: each shape clipped either side of its own cut. */
function markSvg() {
  const { size: S, tile, gap, bar, chevron } = MARK;
  const rect = (fill) => `<rect x="${bar.x}" y="${bar.y}" width="${bar.w}" height="${bar.h}" rx="${bar.r}" fill="${fill}"/>`;
  const path = (fill) => `<path d="M${chevron.points.map(([x, y]) => `${x} ${y}`).join(' L')} Z" fill="${fill}"/>`;
  const clips = (id, cut) => `<clipPath id="${id}-a"><rect width="${S}" height="${cut}"/></clipPath><clipPath id="${id}-b"><rect y="${cut + gap}" width="${S}" height="${S - cut - gap}"/></clipPath>`;
  const halves = (id, shape, draw) => `<g clip-path="url(#${id}-a)">${draw(shape.colours.above)}</g><g clip-path="url(#${id}-b)">${draw(shape.colours.below)}</g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}">
<title>Keel</title>
<defs>${clips('chevron', chevron.cut)}${clips('bar', bar.cut)}</defs>
<rect width="${S}" height="${S}" rx="${tile.radius}" fill="${tile.fill}"/>
${halves('chevron', chevron, path)}
${halves('bar', bar, rect)}
</svg>
`;
}

out('client/public/favicon.svg', markSvg());
out('client/public/icons/icon-192.png', png(markRows(192)));
out('client/public/icons/icon-512.png', png(markRows(512)));
out('client/public/icons/apple-touch-icon.png', png(markRows(180, { tile: 'square' })));
// Android may crop the maskable icon to a circle of 80% of its width: at 0.78 the K's corners sit inside it.
out('client/public/icons/maskable-512.png', png(markRows(512, { tile: 'square', scale: 0.78 })));
out('client/public/icons/badge-96.png', png(markRows(96, { tile: 'none', scale: 1.15, colour: '#ffffff' })));
console.log('assets/pinch.svg, pinch.png, pinch.ico, pinch-transparent.svg, pinch-transparent.png; client/public/favicon.svg, icons/*.png');
