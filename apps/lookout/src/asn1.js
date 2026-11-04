// A DER encoder, as small as X.509 certificates need: Node signs and makes keys (crypto.sign,
// generateKeyPairSync) but builds no certificate, and Lookout takes no dependency to do it. Every
// function returns a Buffer holding one whole element (tag, length, contents). Pure.

/** The length octets: short form under 128, else 0x80 + the number of bytes that follow. */
function lengthOf(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/** One element with tag `tag` around `content` (a Buffer, or a list of them joined). */
export function tlv(tag, content) {
  const body = Array.isArray(content) ? Buffer.concat(content) : content;
  return Buffer.concat([Buffer.from([tag]), lengthOf(body.length), body]);
}

export const sequence = (...items) => tlv(0x30, items.flat());
export const set = (...items) => tlv(0x31, items.flat());
export const nul = () => Buffer.from([0x05, 0x00]);
export const boolean = (v) => tlv(0x01, Buffer.from([v ? 0xff : 0x00]));
export const octetString = (buf) => tlv(0x04, buf);
export const utf8String = (s) => tlv(0x0c, Buffer.from(String(s), 'utf8'));
export const printableString = (s) => tlv(0x13, Buffer.from(String(s), 'ascii'));
export const ia5String = (s) => tlv(0x16, Buffer.from(String(s), 'ascii'));

/** A BIT STRING of whole bytes (keys, signatures), or of `unused` spare bits at the end (key usage). */
export const bitString = (buf, unused = 0) => tlv(0x03, Buffer.concat([Buffer.from([unused]), buf]));

/** [n] EXPLICIT around an element. */
export const explicit = (n, element) => tlv(0xa0 | n, element);

/** [n] IMPLICIT of a primitive: the element's own tag replaced by the context tag, contents kept. */
export const implicit = (n, content) => tlv(0x80 | n, content);

/**
 * An INTEGER from a number or a Buffer of its big-endian bytes, taken as positive: leading zero
 * bytes dropped, one put back when the top bit is set (else it reads as negative).
 */
export function integer(value) {
  let bytes;
  if (Buffer.isBuffer(value)) bytes = value;
  else {
    const out = [];
    for (let v = BigInt(value); v > 0n; v >>= 8n) out.unshift(Number(v & 0xffn));
    bytes = Buffer.from(out.length ? out : [0]);
  }
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0) i++;
  bytes = bytes.subarray(i);
  if (bytes[0] & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return tlv(0x02, bytes);
}

/** An OBJECT IDENTIFIER from its dotted form ("2.5.29.17"). */
export function oid(dotted) {
  const parts = dotted.split('.').map(Number);
  const out = [parts[0] * 40 + parts[1]];
  for (const p of parts.slice(2)) {
    const chunk = [p & 0x7f];
    for (let v = Math.floor(p / 128); v > 0; v = Math.floor(v / 128)) chunk.unshift((v & 0x7f) | 0x80);
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

/**
 * A certificate's time: UTCTime (YYMMDDHHMMSSZ) for 1950 to 2049, GeneralizedTime (YYYYMMDDHHMMSSZ)
 * after, as RFC 5280 asks.
 */
export function time(date) {
  const d = new Date(date);
  const rest = `${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  const y = d.getUTCFullYear();
  if (y >= 1950 && y < 2050) return tlv(0x17, Buffer.from(`${pad(y % 100)}${rest}`, 'ascii'));
  return tlv(0x18, Buffer.from(`${pad(y, 4)}${rest}`, 'ascii'));
}
