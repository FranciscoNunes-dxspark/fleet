import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { allowedEndpoint, encryptPayload, generateVapidKeys, sendPush, vapidAuthorization } from '../server/webpush.js';
import { createPush, openUrl, pushMessages, wanted } from '../server/push.js';
import { translator } from '../server/i18n.js';

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

/** A browser's side: its key pair and auth secret, and how it decrypts a push (RFC 8291). */
function browser() {
  const ecdh = crypto.createECDH('prime256v1');
  const publicKey = ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return {
    keys: { p256dh: publicKey.toString('base64url'), auth: auth.toString('base64url') },
    decrypt(body) {
      const salt = body.subarray(0, 16);
      const rs = body.readUInt32BE(16);
      const idlen = body[20];
      const asPublic = body.subarray(21, 21 + idlen);
      const ciphertext = body.subarray(21 + idlen);
      assert.equal(rs, 4096);
      const shared = ecdh.computeSecret(asPublic);
      const ikm = hmac(hmac(auth, shared), Buffer.concat([Buffer.from('WebPush: info\0'), publicKey, asPublic, Buffer.from([1])]));
      const prk = hmac(salt, ikm);
      const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
      const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
      const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
      decipher.setAuthTag(ciphertext.subarray(-16));
      const plain = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
      assert.equal(plain.at(-1), 2, 'the last record ends with the 0x02 delimiter');
      return plain.subarray(0, -1).toString();
    },
  };
}

test('web push: a message only the subscribed browser can read', () => {
  const b = browser();
  const body = encryptPayload(JSON.stringify({ title: 'Storefront is down' }), b.keys);
  assert.deepEqual(JSON.parse(b.decrypt(body)), { title: 'Storefront is down' });
  assert.throws(() => browser().decrypt(body), 'another browser cannot read it');
  assert.notDeepEqual(encryptPayload('x', b.keys), encryptPayload('x', b.keys), 'a fresh key and salt every time');
  assert.throws(() => encryptPayload('x', { p256dh: 'abc', auth: 'def' }), /Invalid subscription keys/);
});

test('web push: VAPID says who sends, signed with the server key', () => {
  const keys = generateVapidKeys();
  assert.equal(Buffer.from(keys.publicKey, 'base64url').length, 65);
  const header = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', keys, 'https://keel.example.com', Date.parse('2026-10-18T12:00:00Z'));
  const [, jwt, k] = header.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.equal(k, keys.publicKey);
  const [h, c, sig] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(c, 'base64url')), { aud: 'https://fcm.googleapis.com', exp: Date.parse('2026-10-18T12:00:00Z') / 1000 + 43200, sub: 'https://keel.example.com' });
  const point = Buffer.from(keys.publicKey, 'base64url');
  const publicKey = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
});

test('web push: only real push services are sent to', () => {
  assert.ok(allowedEndpoint('https://fcm.googleapis.com/fcm/send/abc'));
  assert.ok(allowedEndpoint('https://web.push.apple.com/QGx'));
  assert.ok(allowedEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x'));
  assert.ok(allowedEndpoint('https://wns2-par02p.notify.windows.com/w/?token=x'));
  assert.equal(allowedEndpoint('http://fcm.googleapis.com/x'), null);
  assert.equal(allowedEndpoint('https://169.254.169.254/latest'), null);
  assert.equal(allowedEndpoint('https://evil.example/fcm.googleapis.com'), null);
  assert.equal(allowedEndpoint('https://fcm.googleapis.com.evil.example/x'), null);
  assert.equal(allowedEndpoint('https://fcm.googleapis.com:8443/x'), null);
  assert.ok(allowedEndpoint('https://push.internal.example/x', ['push.internal.example']), 'PUSH_ALLOW_HOSTS adds one');
});

test('web push: sent to the push service as the RFC asks, and a gone subscription is reported', async () => {
  const b = browser();
  const vapid = generateVapidKeys();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { status: calls.length === 1 ? 201 : 410, ok: calls.length === 1, body: null };
  };
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: b.keys };
  assert.deepEqual(await sendPush(sub, { title: 'Hi' }, { vapid, subject: 'mailto:a@b.c', urgency: 'high', fetchImpl }), { ok: true });
  const { url, init } = calls[0];
  assert.equal(url, sub.endpoint);
  assert.equal(init.headers['Content-Encoding'], 'aes128gcm');
  assert.equal(init.headers.Urgency, 'high');
  assert.match(init.headers.Authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
  assert.equal(init.redirect, 'error');
  assert.deepEqual(JSON.parse(b.decrypt(init.body)), { title: 'Hi' });
  assert.deepEqual(await sendPush(sub, { title: 'Hi' }, { vapid, subject: 'mailto:a@b.c', fetchImpl }), { gone: true });
  await assert.rejects(sendPush({ ...sub, endpoint: 'https://example.com/x' }, {}, { vapid, fetchImpl }), /Not a push service/);
});

test('push: what is sent, in the categories chosen, translated, leading to the right place', () => {
  const notes = [
    { key: 'attention:prod:m1:down', category: 'production', title: 'Shop is down', body: 'Health check failed', target: { type: 'production' }, severity: 'high' },
    { key: 'attention:pr:p1:r1:7', category: 'review', title: 'Add refunds', body: 'Waiting on your review for 1h', target: { type: 'pr', projectId: 'p1', repoId: 'r1', id: 7 }, severity: 'medium' },
    { key: 'attention:pr:p1:r1:8', category: 'pr', title: 'Old PR', body: 'No reviewers assigned', target: { type: 'pr', projectId: 'p1', repoId: 'r1', id: 8 }, severity: 'high' },
  ];
  assert.deepEqual(notes.filter((n) => wanted(n, {})).map((n) => n.category), ['production', 'review'], 'other PR alerts are off unless chosen');
  assert.deepEqual(notes.filter((n) => wanted(n, { production: false, pr: true })).map((n) => n.category), ['review', 'pr']);

  const [prod, review] = pushMessages(notes.slice(0, 2), translator('en'));
  assert.deepEqual(prod, { title: 'Shop is down', body: 'Health check failed', tag: 'attention:prod:m1:down', url: '/production', urgent: true });
  assert.equal(review.title, 'Add refunds', 'an Azure DevOps title stays as it is');
  assert.deepEqual(JSON.parse(new URL(review.url, 'https://k').searchParams.get('open')), { type: 'pr', projectId: 'p1', repoId: 'r1', id: 7 });
  assert.equal(review.urgent, false);

  const many = pushMessages([...notes, ...notes], translator('pt'));
  assert.equal(many.length, 1);
  assert.match(many[0].title, /^6 /);
  assert.equal(many[0].url, '/inbox');
  assert.equal(openUrl({ type: 'approval' }), '/pipelines');
});

test('push: devices per person, sent what is new each look, forgotten when the push service says so', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-push-'));
  const b = browser();
  const sent = [];
  let gone = false;
  let attention = [];
  const service = {
    invalidate: () => {},
    snapshot: async () => ({ attention, myPrs: [], runs: [] }),
    settingsStore: { load: async () => ({ prefs: { notifications: { categories: { approval: true } } } }) },
  };
  const push = createPush({
    dataDir: dir,
    mock: false,
    resolveService: async (userId) => (userId === 'u1' ? service : null),
    send: async (sub, payload, opts) => {
      if (gone) return { gone: true };
      sent.push({ endpoint: sub.endpoint, payload, opts });
      return { ok: true };
    },
    every: 3_600_000,
  });
  try {
    const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/device-1', keys: b.keys };
    assert.throws(() => push.subscribe('u1', { subscription: { ...subscription, endpoint: 'https://example.com/hook' } }), /push service/);
    const device = push.subscribe('u1', { subscription, label: 'Pixel' });
    assert.equal(push.info('u1').devices.length, 1);
    assert.equal(push.info('u2').devices.length, 0, "someone else's devices aren't listed");
    assert.match(fs.readFileSync(path.join(dir, 'push.json'), 'utf8'), /"publicKey"/);
    assert.doesNotMatch(fs.readFileSync(path.join(dir, 'push.json'), 'utf8'), /device-1/, 'push addresses are stored encrypted');

    await push.tick(); // baseline
    assert.equal(sent.length, 0);
    attention = [{ key: 'approval:release:1', kind: 'approval', severity: 'high', title: 'Approve Shop → Production', reasons: [{ text: 'Waiting on you for 5m' }], target: { type: 'approval' } }];
    await push.tick();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].endpoint, subscription.endpoint);
    assert.equal(sent[0].payload.title, 'Approve Shop → Production');
    assert.equal(sent[0].opts.urgency, 'high');
    await push.tick();
    assert.equal(sent.length, 1, 'once');

    await push.test('u1', { id: device.id });
    assert.equal(sent.at(-1).payload.tag, 'keel-test');
    await assert.rejects(push.test('u2', {}), /Turn on push/);

    gone = true;
    await assert.rejects(push.test('u1', {}), /expired/);
    push.subscribe('u1', { subscription, label: 'Pixel' });
    attention = [...attention, { key: 'approval:release:2', kind: 'approval', severity: 'high', title: 'Approve Api → Production', reasons: [{ text: 'Waiting on you for 1m' }], target: { type: 'approval' } }];
    await push.tick();
    assert.equal(push.info('u1').devices.length, 0, 'a subscription the push service no longer has is forgotten');

    push.subscribe('u1', { subscription, label: 'Pixel' });
    push.unsubscribe('u2', { endpoint: subscription.endpoint });
    assert.equal(push.info('u1').devices.length, 1, "you can't remove someone else's device");
    push.unsubscribe('u1', { endpoint: subscription.endpoint });
    assert.equal(push.info('u1').devices.length, 0);
  } finally {
    push.close();
  }
});
