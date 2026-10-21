// Signing in the terminal app (server/terminals.js): a login is started by the terminal, allowed in
// the browser by its typed code, and turned once into a token that acts as that person.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTerminals, normalizeCode, TOKEN_IDLE_DAYS } from '../server/terminals.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-terminals-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
let n = 0;
const fresh = (now) => createTerminals(path.join(dir, `t${n++}.json`), { now });
const DAY = 86_400_000;

test('a login: pending until allowed by its code, then a token, handed out once', () => {
  const t = fresh();
  const login = t.start({ name: 'ana on LAPTOP-7 (Windows)', ip: '10.0.0.5' });
  assert.match(login.userCode, /^[B-DF-HJ-NP-TV-XZ]{4}-[B-DF-HJ-NP-TV-XZ]{4}$/, 'two groups of four consonants');
  assert.equal(login.expiresIn, 600);
  assert.deepEqual(t.poll(login.deviceCode), { status: 'pending' });

  // Typed in lower case, with a space instead of the dash, it's the same code.
  const seen = t.peek(login.userCode.toLowerCase().replace('-', ' '));
  assert.equal(seen.name, 'ana on LAPTOP-7 (Windows)');
  assert.equal(seen.ip, '10.0.0.5');
  t.decide(login.userCode, 'u1', true);

  const got = t.poll(login.deviceCode);
  assert.equal(got.status, 'approved');
  assert.equal(got.userId, 'u1');
  assert.match(got.token, /^keel_/);
  assert.deepEqual(t.poll(login.deviceCode), { status: 'expired' }, 'only once');
  assert.throws(() => t.peek(login.userCode), /isn't one Keel is waiting for/, 'and its code is used up');

  assert.equal(t.verify(got.token).userId, 'u1');
  assert.equal(t.verify('keel_nope'), null);
  assert.equal(t.verify('not a token'), null);
  // Only the hash is kept.
  assert.ok(!fs.readFileSync(path.join(dir, 't0.json'), 'utf8').includes(got.token));
});

test("a refused login gets no token, and a code nobody's waiting for is refused", () => {
  const t = fresh();
  const login = t.start({ name: 'x' });
  assert.throws(() => t.decide('BBBB-BBBB', 'u1', true), (e) => e.status === 404);
  t.decide(login.userCode, 'u1', false);
  assert.deepEqual(t.poll(login.deviceCode), { status: 'denied' });
  assert.deepEqual(t.poll('made-up'), { status: 'expired' });
});

test('a login lasts 10 minutes', () => {
  let now = Date.parse('2026-10-21T10:00:00Z');
  const t = fresh(() => now);
  const login = t.start({ name: 'x' });
  now += 11 * 60_000;
  assert.throws(() => t.peek(login.userCode), (e) => e.status === 404);
  assert.deepEqual(t.poll(login.deviceCode), { status: 'expired' });
});

test('tokens: listed for their person, signed out one by one or all at once, and gone after 90 days unused', () => {
  let now = Date.parse('2026-10-21T10:00:00Z');
  const t = fresh(() => now);
  const signIn = (userId, name) => {
    const login = t.start({ name });
    t.decide(login.userCode, userId, true);
    return t.poll(login.deviceCode).token;
  };
  const a = signIn('u1', 'laptop');
  now += 2 * 60 * 60_000;
  const b = signIn('u1', 'desktop');
  const c = signIn('u2', 'theirs');
  assert.deepEqual(t.list('u1').map((x) => x.name), ['desktop', 'laptop'], 'most recently used first');
  assert.equal(t.list('u2').length, 1);

  // Someone else's id signs nothing out.
  const laptop = t.list('u1').find((x) => x.name === 'laptop');
  assert.equal(t.revoke('u2', laptop.id), false);
  assert.equal(t.revoke('u1', laptop.id), true);
  assert.equal(t.verify(a), null);
  assert.ok(t.verify(b));

  t.revokeToken(b);
  assert.equal(t.verify(b), null);

  // Used now and then, a token stays; unused for 90 days, it's gone.
  now += (TOKEN_IDLE_DAYS - 1) * DAY;
  assert.ok(t.verify(c), 'used on day 89');
  now += (TOKEN_IDLE_DAYS - 1) * DAY;
  assert.ok(t.verify(c), 'still there 89 days after it was last used');
  now += (TOKEN_IDLE_DAYS + 1) * DAY;
  assert.equal(t.verify(c), null);

  const d = signIn('u2', 'again');
  t.revokeAll('u2');
  assert.equal(t.verify(d), null);
  assert.deepEqual(t.list('u2'), []);
});

test('codes are read the way people type them', () => {
  assert.equal(normalizeCode(' wxyz-bcdf '), 'WXYZBCDF');
  assert.equal(normalizeCode('WXYZ BCDF'), 'WXYZBCDF');
  assert.equal(normalizeCode(undefined), '');
});
