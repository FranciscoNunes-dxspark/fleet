// PNG in and out, for comparing screenshots: decode the 8-bit RGB and RGBA images Chrome writes
// (non-interlaced, the five filters) and encode RGBA. Small on purpose: no library to bundle.
import { deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** { width, height, data: RGBA bytes } from a PNG buffer. */
export function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG');
  let pos = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let type = 0;
  let interlace = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const name = buf.toString('latin1', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (name === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8];
      type = body[9];
      interlace = body[12];
    } else if (name === 'IDAT') idat.push(body);
    else if (name === 'IEND') break;
    pos += 12 + len;
  }
  if (depth !== 8 || (type !== 2 && type !== 6) || interlace) throw new Error('only 8-bit RGB or RGBA PNGs, not interlaced');
  const bpp = type === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      if (filter === 1) line[x] = (line[x] + a) & 255;
      else if (filter === 2) line[x] = (line[x] + b) & 255;
      else if (filter === 3) line[x] = (line[x] + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        line[x] = (line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
    }
    for (let x = 0; x < width; x++) {
      out[(y * width + x) * 4] = line[x * bpp];
      out[(y * width + x) * 4 + 1] = line[x * bpp + 1];
      out[(y * width + x) * 4 + 2] = line[x * bpp + 2];
      out[(y * width + x) * 4 + 3] = bpp === 4 ? line[x * bpp + 3] : 255;
    }
    prev = line;
  }
  return { width, height, data: out };
}

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, sum]);
}

/** A PNG buffer from { width, height, data: RGBA bytes }. */
export function encodePng({ width, height, data }) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) data.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * Two images compared: the share of pixels that differ (a small tolerance for antialiasing), the
 * changed regions as boxes (32 px cells joined), and a diff image: the new one faded, changes in red,
 * and height that only one of them has in yellow.
 */
export function diffImages(a, b, { tolerance = 24, cell = 32 } = {}) {
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  const out = Buffer.alloc(width * height * 4);
  const cols = Math.ceil(width / cell);
  const grid = new Uint8Array(cols * Math.ceil(height / cell));
  let changed = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const inA = x < a.width && y < a.height;
      const inB = x < b.width && y < b.height;
      let diff = !inA || !inB;
      if (inA && inB) {
        const ia = (y * a.width + x) * 4;
        const ib = (y * b.width + x) * 4;
        diff = Math.abs(a.data[ia] - b.data[ib]) + Math.abs(a.data[ia + 1] - b.data[ib + 1]) + Math.abs(a.data[ia + 2] - b.data[ib + 2]) > tolerance;
      }
      if (diff) {
        changed++;
        grid[Math.floor(y / cell) * cols + Math.floor(x / cell)] = 1;
        out.set(inA && inB ? [230, 30, 30, 255] : [240, 190, 20, 255], o);
      } else {
        const ib = (y * b.width + x) * 4;
        const g = Math.round((b.data[ib] + b.data[ib + 1] + b.data[ib + 2]) / 3);
        const v = 255 - Math.round((255 - g) * 0.25);
        out.set([v, v, v, 255], o);
      }
    }
  }
  // Changed cells joined into boxes: runs across a row, then rows stacked where they line up.
  const boxes = [];
  const rows = Math.ceil(height / cell);
  for (let r = 0; r < rows; r++) {
    let c = 0;
    while (c < cols) {
      if (!grid[r * cols + c]) {
        c++;
        continue;
      }
      const start = c;
      while (c < cols && grid[r * cols + c]) c++;
      const box = boxes.find((bx) => bx.r2 === r - 1 && bx.c1 === start && bx.c2 === c);
      if (box) box.r2 = r;
      else boxes.push({ r1: r, r2: r, c1: start, c2: c });
    }
  }
  return {
    width,
    height,
    changed,
    share: changed / (width * height),
    boxes: boxes.map((bx) => ({ x: bx.c1 * cell, y: bx.r1 * cell, width: Math.min(width, bx.c2 * cell) - bx.c1 * cell, height: Math.min(height, (bx.r2 + 1) * cell) - bx.r1 * cell })).sort((p, q) => q.width * q.height - p.width * p.height),
    image: { width, height, data: out },
  };
}
