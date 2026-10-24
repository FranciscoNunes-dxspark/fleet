// Draws Fleet's logo into assets/: six tiles in the family's accents, as the bar's six spaces, on the
// dark rounded square the siblings' icons use. logo.svg (README), logo.png (512 px) and logo.ico (the
// Windows executable's icon, which the kit's scripts/build.js embeds). Don't edit assets/ by hand: run
//   node scripts/logo.js
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { SPACES } from '../src/spaces.js';

const BACKGROUND = '#1c1b22';
const UNITS = 32; // the drawing's grid; every size is drawn from it
const RADIUS = 6;
// The tiles: three across, two down, in the order of their keys.
const TILES = SPACES.map((s, i) => ({ colour: s.accent, x: 4 + (i % 3) * 9, y: 6 + Math.floor(i / 3) * 12, w: 6, h: 8 }));

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** The colour at unit coordinates (u, v), [r, g, b, a]. */
function at(u, v) {
  const tile = TILES.find((t) => u >= t.x && u < t.x + t.w && v >= t.y && v < t.y + t.h);
  if (tile) return [...rgb(tile.colour), 255];
  // Outside the rounded square's corners: transparent.
  const cx = Math.min(Math.max(u, RADIUS), UNITS - RADIUS);
  const cy = Math.min(Math.max(v, RADIUS), UNITS - RADIUS);
  if ((u - cx) ** 2 + (v - cy) ** 2 > RADIUS ** 2) return [0, 0, 0, 0];
  return [...rgb(BACKGROUND), 255];
}

/** RGBA rows of the logo at `size` px, each pixel sampled at its centre. */
function canvas(size) {
  return Array.from({ length: size }, (_, y) => {
    const row = Buffer.alloc(size * 4);
    for (let x = 0; x < size; x++) row.set(at(((x + 0.5) * UNITS) / size, ((y + 0.5) * UNITS) / size), x * 4);
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

const svg = [
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${UNITS} ${UNITS}" width="256" height="256">`,
  `  <rect width="${UNITS}" height="${UNITS}" rx="${RADIUS}" fill="${BACKGROUND}"/>`,
  ...TILES.map((t) => `  <rect x="${t.x}" y="${t.y}" width="${t.w}" height="${t.h}" fill="${t.colour}"/>`),
  '</svg>',
  '',
].join('\n');

mkdirSync('assets', { recursive: true });
writeFileSync('assets/logo.svg', svg);
writeFileSync('assets/logo.png', png(canvas(512)));
writeFileSync('assets/logo.ico', ico([16, 24, 32, 48, 64, 128, 256]));
console.log('assets/logo.svg, logo.png, logo.ico');
