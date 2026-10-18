// Web Push (RFC 8030) with what Node already has: VAPID to identify this
// server to the browser's push service (RFC 8292), and the message encrypted
// for the one device it's for (RFC 8291, aes128gcm), so the push service
// can't read it. No dependency: a P-256 key pair, ECDH, HKDF and AES-GCM.
import crypto from 'node:crypto';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s), 'base64url');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

/** A new VAPID key pair: the public key as browsers want it (65-byte point, base64url) and the private one as a JWK. */
export function generateVapidKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  return {
    publicKey: b64u(Buffer.concat([Buffer.from([4]), fromB64u(jwk.x), fromB64u(jwk.y)])),
    privateKey: JSON.stringify(privateKey.export({ format: 'jwk' })),
  };
}

/** The Authorization header for one push service: a signed JWT (ES256) saying who sends, for 12 hours. */
export function vapidAuthorization(endpoint, { publicKey, privateKey }, subject, now = Date.now()) {
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject }));
  const key = crypto.createPrivateKey({ key: JSON.parse(privateKey), format: 'jwk' });
  const signature = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64u(signature)}, k=${publicKey}`;
}

/**
 * Encrypt `payload` for a subscription's keys ({ p256dh, auth }, base64url):
 * one aes128gcm record, with a fresh key pair and salt per message.
 */
export function encryptPayload(payload, { p256dh, auth }, { salt = crypto.randomBytes(16) } = {}) {
  const uaPublic = fromB64u(p256dh);
  const authSecret = fromB64u(auth);
  if (uaPublic.length !== 65 || authSecret.length !== 16) throw new Error('Invalid subscription keys');
  const ecdh = crypto.createECDH('prime256v1');
  const asPublic = ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPublic);

  // RFC 8291 §3.4: mix in the device's auth secret, then derive the content key and nonce (RFC 8188).
  const ikm = hmac(hmac(authSecret, shared), Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  // 0x02: the last (and only) record, no padding.
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

// Push services of the browsers people use. Keel only ever sends to these, so a
// subscription can't point it at another address.
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^(?:[\w-]+\.)*push\.apple\.com$/, /^(?:[\w-]+\.)*notify\.windows\.com$/];

/** A subscription's push endpoint, if it's an https address of a known push service (plus PUSH_ALLOW_HOSTS). */
export function allowedEndpoint(endpoint, extra = (process.env.PUSH_ALLOW_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)) {
  let url;
  try {
    url = new URL(String(endpoint));
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return null;
  const host = url.hostname.toLowerCase();
  return PUSH_HOSTS.some((re) => re.test(host)) || extra.includes(host) ? url.href : null;
}

/**
 * Send one message. Resolves to { ok: true }, or { gone: true } when the push
 * service says the subscription no longer exists (it should be forgotten).
 */
export async function sendPush(subscription, payload, { vapid, subject, urgency = 'normal', ttl = 24 * 3600, fetchImpl = fetch } = {}) {
  const endpoint = allowedEndpoint(subscription.endpoint);
  if (!endpoint) throw new Error('Not a push service address');
  const res = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      Authorization: vapidAuthorization(endpoint, vapid, subject),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(ttl),
      Urgency: urgency,
    },
    body: encryptPayload(JSON.stringify(payload), subscription.keys),
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  res.body?.cancel?.().catch(() => {});
  if (res.status === 404 || res.status === 410) return { gone: true };
  if (!res.ok) throw new Error(`The push service answered HTTP ${res.status}`);
  return { ok: true };
}
