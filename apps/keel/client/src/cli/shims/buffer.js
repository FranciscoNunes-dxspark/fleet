// Enough of Buffer for base64 (OSC 52) and Ink's keypress parser, which takes plain strings too.
class WebBuffer extends Uint8Array {
  toString(encoding) {
    if (encoding === 'base64') return btoa(Array.from(this, (b) => String.fromCharCode(b)).join(''));
    return new TextDecoder().decode(this);
  }
}
export const Buffer = {
  from: (x) => (typeof x === 'string' ? new WebBuffer(new TextEncoder().encode(x)) : WebBuffer.from(x)),
  isBuffer: (x) => x instanceof WebBuffer,
};
export default { Buffer };
