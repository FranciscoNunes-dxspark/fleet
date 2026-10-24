import { test } from 'node:test';
import assert from 'node:assert/strict';

test('host guard: PUBLIC_URL\'s host is served without ALLOWED_HOSTS', async () => {
  process.env.PUBLIC_URL = 'https://keel.example.com/';
  delete process.env.ALLOWED_HOSTS;
  // A fresh copy of the module, so it reads the environment set above.
  const { hostGuard, publicHost } = await import(`../server/security.js?public-url=${Date.now()}`);
  assert.equal(publicHost(), 'keel.example.com');
  assert.equal(publicHost('not a url'), null);
  assert.equal(publicHost(''), null);

  const run = (host, { method = 'GET', origin } = {}) => {
    let status = 200;
    let nextCalled = false;
    const res = { status(s) { status = s; return this; }, type() { return this; }, send() { return this; }, json() { return this; } };
    hostGuard({ method, headers: { host, ...(origin ? { origin } : {}) } }, res, () => { nextCalled = true; });
    return nextCalled ? 200 : status;
  };
  assert.equal(run('keel.example.com'), 200);
  assert.equal(run('keel.example.com:443'), 200);
  assert.equal(run('localhost:4280'), 200);
  assert.equal(run('evil.example'), 421);
  assert.equal(run('www.keel.example.com'), 421, 'other names still need ALLOWED_HOSTS');
  assert.equal(run('keel.example.com', { method: 'POST', origin: 'https://keel.example.com' }), 200);
  assert.equal(run('keel.example.com', { method: 'POST', origin: 'https://evil.example' }), 403);
  delete process.env.PUBLIC_URL;
});
