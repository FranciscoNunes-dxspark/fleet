// Draws Helm's icon into assets/: a console prompt (">_") in the accent colour on the dark square the
// other apps use. The build embeds the .ico as the Windows executable's icon. Run from apps/helm:
// node scripts/logo.js
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const BG = [18, 18, 18];
const FG = [79, 195, 247];
// A 16x16 grid: the chevron and the underscore.
const GRID = [
  '................',
  '................',
  '................',
  '..##............',
  '...###..........',
  '....###.........',
  '.....###........',
  '......###.......',
  '.....###........',
  '....###.........',
  '...###..........',
  '..##............',
  '.........#####..',
  '................',
  '................',
  '................',
];

function pixels(size) {
  const data = Buffer.alloc(size * size * 4);
  const cell = size / 16;
  const radius = size * 0.18;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Rounded corners: transparent outside them.
      const dx = Math.max(radius - x, x - (size - 1 - radius), 0);
      const dy = Math.max(radius - y, y - (size - 1 - radius), 0);
      const inside = dx * dx + dy * dy <= radius * radius;
      const on = GRID[Math.floor(y / cell)][Math.floor(x / cell)] === '#';
      const [r, g, b] = on ? FG : BG;
      data.set([r, g, b, inside ? 255 : 0], (y * size + x) * 4);
    }
  }
  return data;
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, body) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, tail]);
};

function png(size) {
  const raw = pixels(size);
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) raw.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

// An .ico holding PNGs (Windows reads them since Vista); a width of 0 means 256.
function ico(sizes) {
  const images = sizes.map(png);
  const head = Buffer.alloc(6 + 16 * sizes.length);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(sizes.length, 4);
  let offset = head.length;
  sizes.forEach((size, i) => {
    const at = 6 + 16 * i;
    head[at] = size === 256 ? 0 : size;
    head[at + 1] = size === 256 ? 0 : size;
    head.writeUInt16LE(1, at + 4);
    head.writeUInt16LE(32, at + 6);
    head.writeUInt32LE(images[i].length, at + 8);
    head.writeUInt32LE(offset, at + 12);
    offset += images[i].length;
  });
  return Buffer.concat([head, ...images]);
}

mkdirSync('assets', { recursive: true });
writeFileSync('assets/logo.png', png(512));
writeFileSync('assets/logo.ico', ico([16, 32, 48, 64, 128, 256]));
