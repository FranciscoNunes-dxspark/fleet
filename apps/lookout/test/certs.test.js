// The certificates: the DER encoder, a CA and leaf certificates checked by node:crypto's X509Certificate
// and a real TLS handshake, and the CA kept in the user's profile with its key private.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import tls from 'node:tls';
import net from 'node:net';
import { integer, oid, time, tlv } from '../src/asn1.js';
import { certHost, issue, makeCA, makeLeafKey, subjectDer } from '../src/certs.js';
import { caInfo, certCache, ensureCA, loadCA } from '../src/store.js';
import { tempHome } from './helpers.js';

const hex = (b) => b.toString('hex');

test('the DER encoder writes lengths, integers, OIDs and times as X.509 asks', () => {
  assert.equal(hex(tlv(0x04, Buffer.alloc(3))), '0403000000');
  assert.equal(hex(tlv(0x04, Buffer.alloc(200))).slice(0, 6), '0481c8');
  assert.equal(hex(tlv(0x04, Buffer.alloc(300))).slice(0, 8), '0482012c');
  assert.equal(hex(integer(0)), '020100');
  assert.equal(hex(integer(127)), '02017f');
  // A top bit set gets a zero in front, or it would read as negative.
  assert.equal(hex(integer(128)), '02020080');
  assert.equal(hex(integer(Buffer.from([0, 0, 0x85]))), '02020085');
  assert.equal(hex(oid('2.5.29.17')), '0603551d11');
  assert.equal(hex(oid('1.2.840.10045.4.3.2')), '06082a8648ce3d040302');
  assert.equal(time(Date.UTC(2026, 10, 3, 9, 5, 7)).toString('latin1', 2), '261103090507Z');
  assert.equal(time(Date.UTC(2051, 0, 1)).toString('latin1', 2), '20510101000000Z');
  assert.equal(time(Date.UTC(2051, 0, 1))[0], 0x18);
});

test('a CA is a CA: basicConstraints CA:true, its own issuer, signing what it issues', () => {
  const ca = makeCA({ now: Date.UTC(2026, 0, 1) });
  const cert = new X509Certificate(ca.cert);
  assert.equal(cert.ca, true);
  assert.match(cert.subject, /CN=Lookout local CA/);
  assert.equal(cert.subject, cert.issuer);
  assert.ok(cert.verify(cert.publicKey), 'self-signed');
  assert.equal(new Date(cert.validFrom).getUTCFullYear(), 2025);
  assert.equal(new Date(cert.validTo).getUTCFullYear(), 2035);
  assert.match(ca.key, /^-----BEGIN PRIVATE KEY-----/);
});

test('a leaf names its host in subjectAltName, is no CA, and is signed by the CA', () => {
  const ca = makeCA();
  const key = makeLeafKey();
  const caCert = new X509Certificate(ca.cert);
  for (const host of ['api.example.com', 'localhost', '127.0.0.1', '::1']) {
    const leaf = new X509Certificate(issue(host, ca, key));
    assert.equal(leaf.ca, false);
    assert.ok(leaf.verify(caCert.publicKey), `${host} signed by the CA`);
    assert.ok(leaf.checkIssued(caCert), `${host} issued by the CA`);
    if (net.isIP(host)) assert.equal(leaf.checkIP(host), host);
    else assert.equal(leaf.checkHost(host), host);
    assert.equal(leaf.checkHost('other.example.com'), undefined);
    // Node's keyUsage is the extended one: serverAuth.
    assert.deepEqual(leaf.keyUsage, ['1.3.6.1.5.5.7.3.1']);
  }
  // The issuer is the CA's subject; the leaf's own subject is its host.
  const leaf = new X509Certificate(issue('a.test', ca, key));
  assert.equal(leaf.issuer, caCert.subject);
  assert.match(subjectDer(leaf.raw).toString('latin1'), /a\.test/);
  // Only names a certificate can carry.
  assert.equal(certHost('Example.COM.'), 'example.com');
  assert.equal(certHost('bad host'), null);
  assert.throws(() => issue('bad host', ca, key), /isn't a host name/);
});

test('a client trusting the CA completes a real TLS handshake with a leaf, and one that does not refuses it', async () => {
  const ca = makeCA();
  const certs = certCache(ca);
  const server = tls.createServer({ SNICallback: (name, cb) => cb(null, certs.contextFor(name)), ALPNProtocols: ['http/1.1'] }, (s) => s.end('hello'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const connect = (opts) =>
    new Promise((done, fail) => {
      const s = tls.connect({ host: '127.0.0.1', port, servername: 'shop.test', ...opts }, () => {
        let text = '';
        s.on('data', (d) => (text += d));
        s.on('end', () => done({ text, authorized: s.authorized, peer: s.getPeerCertificate(), alpn: s.alpnProtocol }));
      });
      s.on('error', fail);
    });
  try {
    const ok = await connect({ ca: ca.cert, ALPNProtocols: ['h2', 'http/1.1'] });
    assert.equal(ok.text, 'hello');
    assert.equal(ok.authorized, true);
    assert.equal(ok.peer.subject.CN, 'shop.test');
    assert.equal(ok.peer.issuer.CN, 'Lookout local CA');
    assert.equal(ok.alpn, 'http/1.1');
    await assert.rejects(connect({}), /unable to verify|self.signed|UNABLE_TO_VERIFY/i);
    assert.equal(certs.issued, 1, 'the host\'s certificate is made once and kept');
  } finally {
    server.close();
  }
});

test('the CA is made once in the profile, its key readable by the user alone', () => {
  const home = tempHome();
  try {
    assert.equal(caInfo(home.dir).exists, false);
    assert.equal(loadCA(home.dir), null);
    const first = ensureCA(home.dir);
    assert.equal(first.made, true);
    const again = ensureCA(home.dir);
    assert.equal(again.made, false);
    assert.equal(again.ca.cert, first.ca.cert);
    const info = caInfo(home.dir);
    assert.equal(info.exists, true);
    assert.match(info.fingerprint, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    assert.equal(readFileSync(first.paths.cert, 'utf8'), first.ca.cert);
    if (process.platform !== 'win32') {
      assert.equal(statSync(first.paths.key).mode & 0o777, 0o600);
      assert.equal(statSync(home.dir).mode & 0o777, 0o700);
    }
  } finally {
    home();
  }
});
