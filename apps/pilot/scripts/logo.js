// Draws Pilot's icon into assets/: logo.ico (the Windows executable's icon, on the dark rounded
// square), logo-transparent.ico and logo.png, from the pixel-art ship's wheel below.
//   node scripts/logo.js
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const WHEEL = [
  '.......hh.......',
  '.......hh.......',
  '....h.wwww.h....',
  '...hhwwwwwwhh...',
  '...hww.ss.wwh...',
  '..ww.s.ss.s.ww..',
  '..ww..ssss..ww..',
  'hhwwssssccsssswwhh'.slice(1, 17),
  'hhwwssssccsssswwhh'.slice(1, 17),
  '..ww..ssss..ww..',
  '..ww.s.ss.s.ww..',
  '...hww.ss.wwh...',
  '...hhwwwwwwhh...',
  '....h.wwww.h....',
  '.......hh.......',
  '.......hh.......',
];
const COLOURS = { h: '#e0b060', w: '#c08030', s: '#a06828', c: '#7fd4ff' };
const BG = '#14202c';
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), 255];

/** The wheel on a size × size square as RGBA rows: on the dark rounded square, or on transparency. */
function draw(size, dark) {
  const margin = dark ? size * 0.12 : 0;
  const scale = (size - 2 * margin) / 16;
  const radius = size * 0.18;
  return Array.from({ length: size }, (_, y) => {
    const row = [];
    for (let x = 0; x < size; x++) {
      const cx = Math.max(radius - x, x - (size - 1 - radius), 0);
      const cy = Math.max(radius - y, y - (size - 1 - radius), 0);
      const inside = cx * cx + cy * cy <= radius * radius;
      const c = WHEEL[Math.floor((y - margin) / scale)]?.[Math.floor((x - margin) / scale)];
      row.push(...(COLOURS[c] ? hex(COLOURS[c]) : dark && inside ? hex(BG) : [0, 0, 0, 0]));
    }
    return row;
  });
}

function png(rows) {
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
    const body = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(rows[0].length / 4, 0);
  ihdr.writeUInt32BE(rows.length, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const raw = Buffer.concat(rows.map((r) => Buffer.from([0, ...r])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// Uncompressed 32-bit bitmaps (BGRA bottom-up, then the 1-bit mask) up to 128 px, a PNG at 256.
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
      const [r, g, b, a] = src.slice(x * 4, x * 4 + 4);
      pixels.set([b, g, r, a], (y * w + x) * 4);
      if (a === 0) mask[y * maskRow + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return Buffer.concat([head, pixels, mask]);
}

function ico(dark) {
  const sizes = [16, 32, 48, 64, 128, 256];
  const images = sizes.map((s) => (s >= 256 ? png(draw(s, dark)) : dib(draw(s, dark))));
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

const out = new URL('../assets/', import.meta.url);
mkdirSync(out, { recursive: true });
writeFileSync(new URL('logo.ico', out), ico(true));
writeFileSync(new URL('logo-transparent.ico', out), ico(false));
writeFileSync(new URL('logo.png', out), png(draw(256, true)));
console.log('assets/logo.ico, assets/logo-transparent.ico, assets/logo.png');
