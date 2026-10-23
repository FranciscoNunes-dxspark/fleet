// Bosun in the family: /take, a pasted context, /family, and the moods both ways.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeContext, takeLine, writeMood, familyDir } from '../src/family.js';
import { familyMood, reactionTo } from '../src/moods.js';
import { familyOffers, trawlLine } from '../src/actions.js';
import { pastedLine } from '../src/ui/App.jsx';
import { KEYS, project, start, tempHome, type, until } from './helpers.js';

let cleanup;
before(() => (cleanup = tempHome()));
after(() => cleanup());

test('a paste: a command line or a context, without its newline; anything else is keys', () => {
  const ctx = encodeContext('logline', { process: 'api', text: 'x' });
  assert.equal(pastedLine('/restart api\r'), '/restart api');
  assert.equal(pastedLine(`\x1b[200~${ctx}\n\x1b[201~`), ctx);
  assert.equal(pastedLine('/'), null);
  assert.equal(pastedLine('rr'), null);
  assert.equal(pastedLine('/a\n/b'), null);
});

test('Squawk\'s mood for the family, and what it says about the siblings\'', () => {
  const procs = [{ name: 'api', status: 'running', child: {} }, { name: 'web', status: 'crashed' }];
  assert.deepEqual(familyMood({ mood: 'worried', data: { procs } }), { mood: 'worried', reason: 'web crashed' });
  assert.deepEqual(familyMood({ mood: 'idle', data: { procs: [{ name: 'q', gaveUp: true, status: 'crashed' }] } }), { mood: 'sad', reason: 'q gave up restarting' });
  assert.deepEqual(familyMood({ mood: 'wave', data: { procs: [{ name: 'api', status: 'running', child: {}, tests: { state: 'failed', failed: 2 } }] } }), { mood: 'worried', reason: "api: Hail's checks failed" });
  assert.deepEqual(familyMood({ mood: 'wave', data: { procs: [procs[0]] } }), { mood: 'happy', reason: 'all 1 running' });
  assert.deepEqual(familyMood({ mood: 'look', data: null, busy: { label: 'Running' } }), { mood: 'busy', reason: 'Running' });
  assert.deepEqual(familyMood({ mood: 'sleep', data: { procs: [{ name: 'a', status: 'stopped' }] } }), { mood: 'neutral', reason: 'nothing running' });
  const moods = [{ app: 'trawl', mood: 'busy', at: 3 }, { app: 'sonar', mood: 'worried', reason: '12 new exceptions', at: 2 }, { app: 'splice', mood: 'happy', at: 1 }];
  const r = reactionTo(moods);
  assert.equal(r.text, 'Squawk ruffles its feathers: Sonar is worried (12 new exceptions).');
  assert.equal(reactionTo(moods, new Set([r.key])).text, 'Squawk whistles along: Splice is happy.');
  assert.equal(reactionTo(moods, new Set(['sonar:2', 'splice:1'])), null);
});

test('what a project offers the siblings: Splice its checkout, Hail its .http files, Trawl its databases, never a password', () => {
  const found = {
    dir: '/w/shop',
    repo: '/w/shop',
    httpFiles: ['/w/shop/api/orders.http'],
    databases: [
      { name: 'Shop', source: 'appsettings.json', kind: 'sqlserver', server: 'shop.database.windows.net', database: 'Shop', entra: true },
      { name: 'Local', source: 'appsettings.Development.json', kind: 'sqlserver', server: 'localhost', port: 14330, database: 'Shop Dev', user: 'sa', password: 'Secret1!' },
      { name: 'DATABASE_URL', source: '.env', kind: 'postgres', server: 'db.local', port: 5432, database: 'shop', user: 'me', password: 'p' },
    ],
  };
  const offers = familyOffers(found);
  assert.deepEqual(offers.map((o) => [o.app, o.line]), [
    ['Splice', '/open /w/shop'],
    ['Hail', '/open /w/shop/api/orders.http'],
    ['Trawl', '/azure-sql shop.database.windows.net Shop'],
    ['Trawl', '/add shop-shop-dev localhost,14330 "Shop Dev" --user sa'],
    ['Trawl', '/add shop-shop db.local shop --kind postgres --user me'],
  ]);
  assert.ok(offers.every((o) => !/Secret1|\bp\b(?!ostgres)/.test(o.line.replace('/open', ''))));
  assert.equal(trawlLine('x', { name: 'M', kind: 'mysql', server: 'h', port: 3307, user: 'u' }), '/add x-m h:3307 --kind mysql --user u');
});

test('/take finds a sibling\'s log line in the crew\'s logs; other kinds are another app\'s; a pasted context opens the prompt', async () => {
  const dir = project({ procs: { api: 'node api.js' } }, { 'api.js': `console.log('GET /orders requestId=req_424242 500'); console.log('fine'); setInterval(() => {}, 1000);` });
  const app = start({ dir });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('req_424242'), 'the log');
    app.stdin.write(takeLine('logline', { process: 'api', text: 'boom', requestId: 'req_424242' }));
    await until(() => frame().includes('family:v1:logline:') && frame().includes('enter run'), 'the pasted line in the prompt');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('From api: boom') && /api\s+GET \/orders requestId=req_424242 500/.test(frame()), 'the line that says it');
    app.stdin.write(KEYS.esc);
    await until(() => !frame().includes('From api'), 'closed');
    app.stdin.write(encodeContext('commit', { hash: 'abc1234' }));
    await until(() => frame().includes('enter run'), 'a bare context in the prompt');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes("That's for Splice: paste it into Splice's prompt"), 'another app\'s');
  } finally {
    app.unmount();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('/family lists what the project offers and ↵ copies it', async () => {
  const dir = project({ procs: {} }, { 'orders.http': 'GET http://localhost/orders', 'appsettings.json': JSON.stringify({ ConnectionStrings: { Shop: 'Server=localhost;Database=Shop;User ID=sa;Password=hunter2' } }) });
  const copied = [];
  const app = start({ dir, copy: (t) => copied.push(t) });
  const frame = () => app.lastFrame() ?? '';
  try {
    app.stdin.write('/');
    await type(app.stdin, 'family');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('For the family') && frame().includes('Hail') && frame().includes('/add'), 'the offers');
    assert.doesNotMatch(frame(), /hunter2/);
    app.stdin.write(KEYS.enter);
    await until(() => copied.length === 1 && frame().includes("Copied for Hail: paste it into Hail's prompt"), 'copied');
    assert.equal(copied[0], `/open ${join(dir, 'orders.http')}`.replace(/^\/open (.*\s.*)$/, '/open "$1"'));
  } finally {
    app.unmount();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('moods: Squawk says when a sibling is worried (esc puts it away), and tells them about a crash; the setting stops both', async () => {
  const fam = familyDir();
  mkdirSync(fam, { recursive: true });
  writeMood('sonar', { mood: 'worried', reason: 'production has 12 new exceptions' }, { dir: fam });
  const dir = project({ procs: { queue: 'node crash.js' } }, { 'crash.js': `setTimeout(() => process.exit(3), 100);` });
  const app = start({ dir, moodEvery: 200 });
  const frame = () => app.lastFrame() ?? '';
  const mine = () => {
    try {
      return JSON.parse(readFileSync(join(fam, 'bosun.mood.json'), 'utf8'));
    } catch {
      return null;
    }
  };
  try {
    await until(() => frame().includes('Squawk ruffles its feathers: Sonar is worried (production has 12 new exceptions).'), 'the reaction');
    await until(() => mine()?.mood === 'worried' && mine()?.reason === 'queue crashed', 'Bosun\'s mood written');
    app.stdin.write(KEYS.esc);
    await until(() => !frame().includes('Sonar is worried'), 'put away');
    await new Promise((r) => setTimeout(r, 500));
    assert.doesNotMatch(frame(), /Sonar is worried/, 'once');
    writeMood('splice', { mood: 'happy', reason: 'PR merged' }, { dir: fam });
    await until(() => frame().includes('Splice is happy (PR merged)'), 'a new one');
  } finally {
    app.unmount();
    rmSync(dir, { recursive: true, force: true });
  }
});
