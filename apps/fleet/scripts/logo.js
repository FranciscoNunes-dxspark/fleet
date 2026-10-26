// Draws Fleet's logo into assets/: a ship's wheel with six handles in the family's accents, one per
// space in the bar, clockwise from the top in the order of their keys, on the dark rounded square the
// siblings' icons use. It's pixel art on a 32-pixel grid, lit from the top left. logo.svg (README),
// logo.png (512 px) and logo.ico (the Windows executable's icon, which the kit's scripts/build.js
// embeds). Don't edit assets/ by hand: run
//   node scripts/logo.js
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { SPACES } from '../src/spaces.js';

const BACKGROUND = '#1c1b22';
const UNITS = 32; // the drawing's grid; every size is drawn from it
const RADIUS = 6;
const CENTRE = UNITS / 2;

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const WOOD = rgb('#a8784a');
const WOOD_LIGHT = rgb('#d4a46e');
const WOOD_DARK = rgb('#6b4a2e');
const BRASS = rgb('#f2c14e');
const BOLT = rgb('#2a2733');

// The wheel's measures, in grid units from the centre.
const BOLT_R = 1.4;
const HUB_R = 3.2;
const RIM_IN = 6.6;
const RIM_OUT = 8.8;
const SPOKE = 0.9; // half a spoke's width
const NECK_TO = 10; // where a handle's wooden neck meets its knob
const KNOB = { at: 12.3, length: 2.5, width: 2.5 }; // an ellipse along the spoke: centre, half-length, half-width

/** How much a surface facing (vx, vy) is lit, from -1 to 1. */
const litOf = (vx, vy) => {
  const n = Math.hypot(vx, vy);
  return n ? -(vx + vy) / (n * Math.SQRT2) : 0;
};
const shade = (colour, lit) => (lit > 0.35 ? mix(colour, [255, 255, 255], 0.3) : lit < -0.35 ? mix(colour, [0, 0, 0], 0.3) : colour);

/** The wheel's colour at grid pixel (x, y), [r, g, b], or null where the background shows. */
function wheel(x, y) {
  const dx = x + 0.5 - CENTRE;
  const dy = y + 0.5 - CENTRE;
  const r = Math.hypot(dx, dy);
  if (r <= BOLT_R) return BOLT;
  if (r <= HUB_R) return shade(BRASS, litOf(dx, dy));
  if (r >= RIM_IN && r <= RIM_OUT) {
    const lit = litOf(dx, dy);
    if (r > RIM_OUT - 0.9) return lit > -0.3 ? WOOD_LIGHT : WOOD;
    if (r < RIM_IN + 0.9) return lit > 0.3 ? WOOD : WOOD_DARK;
    return lit > 0.3 ? WOOD : lit < -0.3 ? WOOD_DARK : mix(WOOD, WOOD_DARK, 0.4);
  }
  for (const [i, space] of SPACES.entries()) {
    const a = ((-90 + 60 * i) * Math.PI) / 180;
    const ax = Math.cos(a);
    const ay = Math.sin(a);
    const t = dx * ax + dy * ay; // along the spoke
    const s = -dx * ay + dy * ax; // across it
    if (t <= 0) continue;
    if (t < RIM_IN && Math.abs(s) < SPOKE) return WOOD_LIGHT;
    if (t > RIM_OUT && t < NECK_TO && Math.abs(s) < SPOKE) return WOOD;
    const u = (t - KNOB.at) / KNOB.length;
    const v = s / KNOB.width;
    if (u * u + v * v <= 1) {
      const colour = rgb(space.accent);
      // The knob's middle is its own colour, its rim lit or in shadow as its surface faces.
      return u * u + v * v < 0.35 ? colour : shade(colour, litOf(u * ax - v * ay, u * ay + v * ax));
    }
  }
  return null;
}

const PIXELS = Array.from({ length: UNITS }, (_, y) => Array.from({ length: UNITS }, (_, x) => wheel(x, y)));

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
 * a spoke or thicken a handle, so each is the average of a grid of samples inside it.
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
