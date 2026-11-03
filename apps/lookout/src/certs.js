// Lookout's certificates: a local certificate authority made once, and a certificate for each host
// it intercepts, signed by it. X.509 v3 written out with asn1.js and signed with node:crypto, ECDSA
// P-256 with SHA-256 throughout (quick to make, and every browser and runtime takes it). Pure but for
// the clock and the random serials: where the CA is kept is store.js's.
import { X509Certificate, createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { isIP } from 'node:net';
import { bitString, boolean, explicit, implicit, integer, octetString, oid, sequence, set, time, utf8String } from './asn1.js';

const OID = {
  ecdsaSha256: '1.2.840.10045.4.3.2',
  commonName: '2.5.4.3',
  organization: '2.5.4.10',
  organizationalUnit: '2.5.4.11',
  subjectKeyId: '2.5.29.14',
  keyUsage: '2.5.29.15',
  subjectAltName: '2.5.29.17',
  basicConstraints: '2.5.29.19',
  authorityKeyId: '2.5.29.35',
  extKeyUsage: '2.5.29.37',
  serverAuth: '1.3.6.1.5.5.7.3.1',
};

const DAY = 24 * 60 * 60 * 1000;
/** The CA's name, as the trust stores show it. */
export const CA_NAME = 'Lookout local CA';
// A leaf lasts a year (browsers refuse more than 398 days); the CA ten, so it's trusted once.
const LEAF_DAYS = 365;
const CA_DAYS = 3650;

/** A distinguished name: CN, then O and OU when given. */
function name({ cn, o, ou }) {
  const rdn = (type, value) => set(sequence(oid(type), utf8String(value)));
  return sequence(...[o && rdn(OID.organization, o), ou && rdn(OID.organizationalUnit, ou), rdn(OID.commonName, cn)].filter(Boolean));
}

const extension = (id, value, critical = false) => sequence(oid(id), ...(critical ? [boolean(true)] : []), octetString(value));
const keyId = (spki) => createHash('sha1').update(spki).digest();
const serial = () => {
  const b = randomBytes(16);
  b[0] &= 0x7f;
  return b;
};

/** The PEM armour around DER bytes. */
export function pem(label, der) {
  const b64 = der.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '');
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

/** A host's name as a certificate may carry it: a DNS name or an IP address, else null. */
export function certHost(host) {
  const h = String(host ?? '').replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(h)) return h;
  return /^(?=.{1,253}$)[a-z0-9_*]([a-z0-9_-]{0,62})(\.[a-z0-9_]([a-z0-9_-]{0,62}))*\.?$/.test(h) ? h.replace(/\.$/, '') : null;
}

/** An IP address as the bytes subjectAltName's iPAddress holds. */
function ipBytes(ip) {
  if (isIP(ip) === 4) return Buffer.from(ip.split('.').map(Number));
  const [head, tail = ''] = ip.split('::');
  const words = (s) => (s ? s.split(':') : []);
  const h = words(head);
  const t = words(tail);
  // An IPv4 tail (::ffff:1.2.3.4) is two words.
  const last = t.length ? t : h;
  if (last.length && last.at(-1).includes('.')) {
    const v4 = last.pop().split('.').map(Number);
    last.push(((v4[0] << 8) | v4[1]).toString(16), ((v4[2] << 8) | v4[3]).toString(16));
  }
  const all = ip.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  const out = Buffer.alloc(16);
  all.forEach((w, i) => out.writeUInt16BE(parseInt(w || '0', 16), i * 2));
  return out;
}

/** The certificate around a to-be-signed part, signed with `key` (ECDSA, SHA-256). */
function signed(tbs, key) {
  return sequence(tbs, sequence(oid(OID.ecdsaSha256)), bitString(sign('sha256', tbs, key)));
}

/**
 * A new certificate authority: { key, cert } in PEM (the key PKCS#8), basicConstraints CA:true
 * (no CA below it) and keyCertSign. `now` is when it starts, a day early for clocks that are behind.
 */
export function makeCA({ now = Date.now(), cn = CA_NAME } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const subject = name({ cn, o: 'Lookout', ou: 'made on this machine; its key never leaves it' });
  const tbs = sequence(
    explicit(0, integer(2)),
    integer(serial()),
    sequence(oid(OID.ecdsaSha256)),
    subject,
    sequence(time(now - DAY), time(now + CA_DAYS * DAY)),
    subject,
    spki,
    explicit(
      3,
      sequence(
        extension(OID.basicConstraints, sequence(boolean(true), integer(0)), true),
        // digitalSignature, keyCertSign and cRLSign: bits 0, 5 and 6, so the last bit is spare.
        extension(OID.keyUsage, bitString(Buffer.from([0x86]), 1), true),
        extension(OID.subjectKeyId, octetString(keyId(spki))),
      ),
    ),
  );
  return { key: privateKey.export({ type: 'pkcs8', format: 'pem' }), cert: pem('CERTIFICATE', signed(tbs, privateKey)) };
}

/** A key pair for leaf certificates, PEM: one per run serves every host. */
export function makeLeafKey() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return privateKey.export({ type: 'pkcs8', format: 'pem' });
}

/**
 * A certificate for `host` (a DNS name or an IP address) signed by `ca` ({ key, cert } PEM), for
 * `leafKey` (PEM): subjectAltName names the host, extKeyUsage serverAuth. PEM.
 */
export function issue(host, ca, leafKey, { now = Date.now() } = {}) {
  const h = certHost(host);
  if (!h) throw new Error(`${host} isn't a host name a certificate can carry.`);
  const caCert = new X509Certificate(ca.cert);
  const caKey = createPrivateKey(ca.key);
  const caSpki = caCert.publicKey.export({ type: 'spki', format: 'der' });
  const spki = createPublicKey(leafKey).export({ type: 'spki', format: 'der' });
  // The issuer exactly as the CA's own subject is written, which is how a client matches them.
  const issuer = subjectDer(caCert.raw);
  const ip = isIP(h);
  const san = ip ? implicit(7, ipBytes(h)) : implicit(2, Buffer.from(h, 'ascii'));
  const tbs = sequence(
    explicit(0, integer(2)),
    integer(serial()),
    sequence(oid(OID.ecdsaSha256)),
    issuer,
    sequence(time(now - DAY), time(now + LEAF_DAYS * DAY)),
    name({ cn: h.slice(0, 64), o: 'Lookout' }),
    spki,
    explicit(
      3,
      sequence(
        extension(OID.basicConstraints, sequence(), true),
        // digitalSignature: bit 0, seven spare.
        extension(OID.keyUsage, bitString(Buffer.from([0x80]), 7), true),
        extension(OID.extKeyUsage, sequence(oid(OID.serverAuth))),
        extension(OID.subjectAltName, sequence(san)),
        extension(OID.subjectKeyId, octetString(keyId(spki))),
        extension(OID.authorityKeyId, sequence(implicit(0, keyId(caSpki)))),
      ),
    ),
  );
  return pem('CERTIFICATE', signed(tbs, caKey));
}

// Reading DER back, only as far as finding the subject in a certificate.
function readTlv(buf, at) {
  const tag = buf[at];
  let len = buf[at + 1];
  let head = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[at + 2 + i];
    head = 2 + n;
  }
  return { tag, start: at, body: at + head, end: at + head + len };
}

/** The subject Name of a DER certificate, as its bytes. */
export function subjectDer(der) {
  const cert = readTlv(der, 0);
  const tbs = readTlv(der, cert.body);
  let at = tbs.body;
  const fields = [];
  while (at < tbs.end && fields.length < 6) {
    const f = readTlv(der, at);
    fields.push(f);
    at = f.end;
  }
  // version [0], serial, signature, issuer, validity, subject.
  const subject = fields[0].tag === 0xa0 ? fields[5] : fields[4];
  return der.subarray(subject.start, subject.end);
}

/** The SHA-256 fingerprint a trust store shows, AA:BB:… */
export const fingerprint = (certPem) => new X509Certificate(certPem).fingerprint256;
