// Draws Fleet's logo into assets/: a container ship, its bridge at the stern and a stack of boxes
// forward, the one ship that carries many loads, as Fleet carries the apps. The boxes are steel, one
// orange, and never one per app, so the drawing stays the same however many apps there are. It's pixel
// art on a 32-pixel grid, lit from the top left, on the dark rounded square the siblings' icons use.
// logo.svg (README), logo.png (512 px) and logo.ico (the Windows executable's icon, which the kit's
// scripts/build.js embeds). Don't edit assets/ by hand: run
//   node scripts/logo.js
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const BACKGROUND = '#1c1b22';
const UNITS = 32; // the drawing's grid; every size is drawn from it
const RADIUS = 6;

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const WHITE = rgb('#f4f4f0');
const WHITE_DARK = rgb('#c8ccd4');
const GLASS = rgb('#2b3a55');
const GLASS_LIGHT = rgb('#7ec8ff');
const NAVY = rgb('#22304f');
const NAVY_LIGHT = rgb('#3a5080');
const RED = rgb('#d64545');
const BLACK = rgb('#121218');
const WATER = rgb('#3a6b8a');
const WATER_LIGHT = rgb('#5fafd7');
const STEEL = '#5f7a99';
const GREY = '#8a96a3';
const ORANGE = '#e07b39';

// The ship's measures, in grid pixels; it faces right.
const BRIDGE = { left: 4, right: 8, top: 5 }; // its roof; the wings stick out a pixel either side
const DECK = 17; // the hull's top row, which the bridge and the boxes stand on
const KEEL = 22;
const HULL = { stern: 2, bow: 29 };
const BOX = { left: 10, width: 5, height: 3 }; // a pixel's gap between boxes across, none down
// The stack, bottom row first.
const BOXES = [
  [STEEL, ORANGE, STEEL],
  [GREY, STEEL, GREY],
  [STEEL, GREY, STEEL],
];
const WAVES = 25;

/** A container's pixel: ribbed sides, every other column a shade darker, a lit top, the door end in shadow. */
function box(colour, x, y) {
  const c = rgb(colour);
  if (y === 0) return mix(c, WHITE, 0.25);
  if (x === BOX.width - 1) return mix(c, BLACK, 0.35);
  return x % 2 ? mix(c, BLACK, 0.15) : c;
}

/** The ship's colour at grid pixel (x, y), [r, g, b], or null where the background shows. */
function ship(x, y) {
  const { left, right, top } = BRIDGE;
  // The funnel behind the bridge, red with a black top.
  if (x >= left + 1 && x <= left + 2 && y >= top - 3 && y < top) return y === top - 3 ? BLACK : RED;
  if (y === top && x >= left - 1 && x <= right + 1) return WHITE_DARK;
  if (y === top + 1 && x >= left && x <= right) return x === right ? GLASS_LIGHT : GLASS; // the bridge's windows
  if (y > top + 1 && y < DECK && x >= left && x <= right) {
    if ((y - top) % 3 === 1 && x > left && x < right) return mix(WHITE_DARK, GLASS, 0.4); // a deck's portholes
    return x === left ? WHITE_DARK : WHITE;
  }
  if (y < DECK && x >= BOX.left) {
    const row = Math.floor((DECK - 1 - y) / BOX.height);
    const column = Math.floor((x - BOX.left) / (BOX.width + 1));
    const bx = (x - BOX.left) % (BOX.width + 1);
    const colour = BOXES[row]?.[column];
    if (colour && bx < BOX.width) return box(colour, bx, (y - (DECK - (row + 1) * BOX.height)));
  }
  if (y >= DECK && y <= KEEL) {
    // The bow raked forward at the top, the stern a little under.
    const k = (y - DECK) / (KEEL - DECK);
    if (x >= HULL.stern + Math.round(k * 1.5) && x <= HULL.bow - Math.round(k * k * 5)) {
      return y === DECK ? NAVY_LIGHT : y >= KEEL - 1 ? RED : NAVY;
    }
  }
  if (y === WAVES && x >= 3 && x <= 28 && x % 4 !== 3) return x % 4 === 0 ? WATER_LIGHT : WATER;
  return null;
}

const PIXELS = Array.from({ length: UNITS }, (_, y) => Array.from({ length: UNITS }, (_, x) => ship(x, y)));

/** The colour at unit coordinates (u, v), [r, g, b, a]. */
function at(u, v) {
  const pixel = PIXELS[Math.floor(v)]?.[Math.floor(u)];
  if (pixel) return [...pixel, 255];
  // Outside the rounded square's corners: transparent.
  const cx = Math.min(Math.max(u, RADIUS), UNITS - RADIUS);
  const cy = Math.min(Math.max(v, RADIUS), UNITS - RADIUS);
  if ((u - cx) ** 2 + (v - cy) ** 2 > RADIUS ** 2) return [0, 0, 0, 0];
  return [...rgb(BACKGROUND), 255];
}

/**
 * RGBA rows of the logo at `size` px. At a multiple of the grid's 32 every pixel is one colour of the
 * drawing, sampled at its centre; at the sizes in between (the .ico's 16, 24 and 48, which Windows
 * shows in lists and the taskbar) a pixel would fall across the drawing's, and one sample would drop
 * a line of windows or thicken a gap, so each is the average of a grid of samples inside it.
 */
function canvas(size) {
  const n = size % UNITS === 0 ? 1 : 8;
  return Array.from({ length: size }, (_, y) => {
    const row = Buffer.alloc(size * 4);
    for (let x = 0; x < size; x++) {
      const sum = [0, 0, 0, 0];
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const c = at(((x + (i + 0.5) / n) * UNITS) / size, ((y + (j + 0.5) / n) * UNITS) / size);
          // Colours weighed by how opaque they are, so the transparent corners don't darken the edge.
          for (let k = 0; k < 3; k++) sum[k] += c[k] * c[3];
          sum[3] += c[3];
        }
      }
      const a = sum[3];
      row.set(a ? [...sum.slice(0, 3).map((v) => Math.round(v / a)), Math.round(a / (n * n))] : [0, 0, 0, 0], x * 4);
    }
    return row;
  });
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

const hex = (c) => '#' + c.map((n) => n.toString(16).padStart(2, '0')).join('');
// The pixels as one rect per run of a colour along a row.
const runs = PIXELS.flatMap((row, y) => {
  const out = [];
  for (let x = 0; x < UNITS; x++) {
    if (!row[x]) continue;
    const colour = hex(row[x]);
    const last = out.at(-1);
    if (last && last.colour === colour && last.x + last.w === x) last.w++;
    else out.push({ x, y, w: 1, colour });
  }
  return out;
});

const svg = [
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${UNITS} ${UNITS}" width="256" height="256" shape-rendering="crispEdges">`,
  `  <rect width="${UNITS}" height="${UNITS}" rx="${RADIUS}" fill="${BACKGROUND}"/>`,
  ...runs.map((p) => `  <rect x="${p.x}" y="${p.y}" width="${p.w}" height="1" fill="${p.colour}"/>`),
  '</svg>',
  '',
].join('\n');

mkdirSync('assets', { recursive: true });
writeFileSync('assets/logo.svg', svg);
writeFileSync('assets/logo.png', png(canvas(512)));
writeFileSync('assets/logo.ico', ico([16, 24, 32, 48, 64, 128, 256]));
console.log('assets/logo.svg, logo.png, logo.ico');
