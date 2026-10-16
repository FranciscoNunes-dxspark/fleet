// Demo attachments: a generated "screenshot" PNG and a few small text files,
// so the work item panel has something real to preview and download.
import { deflateSync } from 'node:zlib';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** A 480×270 mock app screen with a red error banner; `seed` shifts the layout. */
export function screenshotPng(seed = 0) {
  const W = 480;
  const H = 270;
  const rows = [];
  const color = (x, y) => {
    if (y < 28) return [32, 38, 46]; // top bar
    if (x < 96) return [24, 29, 36]; // sidebar
    if (y >= 44 && y < 70 && x >= 112 && x < 464) return [122, 32, 38]; // error banner
    const line = Math.floor((y - 86) / 22);
    const len = 180 + ((line * 53 + seed * 31) % 170);
    if (y >= 86 && (y - 86) % 22 < 10 && x >= 112 && x < 112 + len) return [58, 66, 78]; // text lines
    return [18, 22, 28];
  };
  for (let y = 0; y < H; y++) {
    const row = Buffer.alloc(1 + W * 3);
    for (let x = 0; x < W; x++) Buffer.from(color(x, y)).copy(row, 1 + x * 3);
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** The bytes of a demo attachment, by file name. */
export function demoFile(name, seed) {
  if (/\.png$/i.test(name)) return screenshotPng(seed);
  if (/\.csv$/i.test(name)) return Buffer.from('invoice,customer,total\nINV-1001,Contoso,120.50\nINV-1002,Fabrikam,89.00\n');
  if (/\.log$/i.test(name)) return Buffer.from('12:04:11 GET /api/orders 200 84ms\n12:04:12 POST /api/checkout 502 30012ms\n12:04:12 upstream timed out (payments-service)\n');
  return Buffer.from(`Demo attachment: ${name}\n`);
}
