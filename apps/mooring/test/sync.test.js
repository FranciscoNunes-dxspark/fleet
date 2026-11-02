// Syncing a folder (sync.js, /sync, /watch): the ignore list, the plan each way, checksums, the last
// sync's state, and the commands end to end over the demo host and machine.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLocal } from '../src/local.js';
import { demoLocal, demoSession, demoSum } from '../src/demo.js';
import { checksumCandidates, checksumCommand, ignoreList, isIgnored, loadBase, pairKey, parentsOf, parseChecksums, planCounts, planSync, saveBase, walkTree } from '../src/sync.js';
import { shellQuote } from '../src/sftp.js';
import { KEYS, shows, start, tempDir, tempHome, type, until } from './helpers.js';

let cleanup;
beforeEach(() => {
  cleanup = tempHome();
});
afterEach(() => cleanup());

const T = Date.UTC(2026, 9, 28, 9, 0);
const files = (o) => new Map(Object.entries(o).map(([k, [size, modified = T]]) => [k, { size, modified }]));
const plain = (plan) => plan.map((p) => `${p.action} ${p.rel}`);

test('the ignore list: .git and node_modules always, a name anywhere, a path from the top, globs', () => {
  const p = ignoreList('# build output\n*.log\n/dist\ncache/tmp/\n!keep.log\n\n');
  assert.deepEqual(p, ['.git', 'node_modules', '*.log', '/dist', 'cache/tmp/']);
  assert.ok(isIgnored(p, '.git'));
  assert.ok(isIgnored(p, 'web/node_modules/x/y.js'));
  assert.ok(isIgnored(p, 'logs/today.log'));
  assert.ok(isIgnored(p, 'dist/app.js'));
  assert.ok(!isIgnored(p, 'src/dist/app.js'));
  assert.ok(isIgnored(p, 'cache/tmp/a'));
  assert.ok(!isIgnored(p, 'cache/other'));
  assert.ok(!isIgnored(p, 'src/index.js'));
});

test('a plan up, down and both ways: new, changed, extra unless --delete, and conflicts', () => {
  const local = files({ 'a.txt': [10, T + 60_000], 'new.txt': [5], 'same.txt': [3], 'tie.txt': [4] });
  const remote = files({ 'a.txt': [9], 'old.txt': [7], 'same.txt': [3, T + 1000], 'tie.txt': [8] });
  assert.deepEqual(plain(planSync({ local, remote, direction: 'up' })), ['upload a.txt', 'upload new.txt', 'extra old.txt', 'upload tie.txt']);
  assert.deepEqual(plain(planSync({ local, remote, direction: 'up', deletes: true })), ['upload a.txt', 'upload new.txt', 'delete-remote old.txt', 'upload tie.txt']);
  assert.deepEqual(plain(planSync({ local, remote, direction: 'down', deletes: true })), ['download a.txt', 'delete-local new.txt', 'download old.txt', 'download tie.txt']);
  // Without a last sync, the newer copy wins; the same time but not the same size can't be settled.
  const both = planSync({ local, remote });
  assert.deepEqual(plain(both), ['upload a.txt', 'upload new.txt', 'download old.txt', 'conflict tie.txt']);
  assert.deepEqual(planCounts(both), { upload: 2, download: 1, 'delete-local': 0, 'delete-remote': 0, conflict: 1, extra: 0 });
  // With one: which side changed, what was deleted on which side, and a change on both is a conflict.
  const base = files({ 'a.txt': [9], 'old.txt': [7], 'gone.txt': [2], 'tie.txt': [6] });
  const l2 = files({ 'a.txt': [10, T + 60_000], 'gone.txt': [2], 'tie.txt': [4] });
  const r2 = files({ 'a.txt': [9], 'tie.txt': [8] });
  assert.deepEqual(plain(planSync({ local: l2, remote: r2, base })), ['upload a.txt', 'extra gone.txt', 'conflict tie.txt']);
  assert.deepEqual(plain(planSync({ local: l2, remote: r2, base, deletes: true })), ['upload a.txt', 'delete-local gone.txt', 'conflict tie.txt']);
  assert.deepEqual(plain(planSync({ local: files({ 'a.txt': [9] }), remote: files({ 'a.txt': [11, T + 5000] }), base: files({ 'a.txt': [9] }) })), ['download a.txt']);
  // A checksum that says the same leaves a file alone.
  assert.deepEqual(plain(planSync({ local: files({ 'x': [3, T + 9000] }), remote: files({ 'x': [3] }), direction: 'up', same: new Set(['x']) })), []);
  assert.deepEqual(parentsOf(['a/b/c.txt', 'a/d.txt', 'e.txt']), ['a', 'a/b']);
});

test('checksums: only files of the same size and another time are asked about, in one command', () => {
  const local = files({ 'a b.txt': [3, T + 9000], 'c.txt': [4, T + 9000], 'd.txt': [5] });
  const remote = files({ 'a b.txt': [3], 'c.txt': [9], 'd.txt': [5] });
  assert.deepEqual(checksumCandidates(local, remote), ['a b.txt']);
  assert.equal(checksumCommand('/srv/it', ["a b.txt", "it's"], shellQuote), "cd '/srv/it' && sha256sum -- 'a b.txt' 'it'\\''s'");
  const h = 'e'.repeat(64);
  assert.deepEqual([...parseChecksums(`${h}  a b.txt\n${h} *bin.dat\n\\${h}  odd\\nname\nnoise\n`)], [['a b.txt', h], ['bin.dat', h]]);
});

test("a real folder is walked with the ignore list, hashed as sha256sum would, and the last sync's state is kept", async () => {
  const t = tempDir();
  try {
    mkdirSync(join(t.dir, 'src', 'deep'), { recursive: true });
    mkdirSync(join(t.dir, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(t.dir, 'src', 'deep', 'a.js'), 'hello');
    writeFileSync(join(t.dir, 'node_modules', 'x', 'i.js'), 'no');
    writeFileSync(join(t.dir, 'top.log'), 'no');
    const local = createLocal({ dir: t.dir });
    const { files: found, dirs } = await walkTree(local, t.dir, ignoreList('*.log'));
    assert.deepEqual([...found.keys()], ['src/deep/a.js']);
    assert.deepEqual([...dirs], ['src', 'src/deep']);
    assert.equal(found.get('src/deep/a.js').size, 5);
    assert.equal(await local.hash(join(t.dir, 'src', 'deep', 'a.js')), '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    assert.equal(await local.readText(join(t.dir, 'missing')), null);
    const key = pairKey('web', t.dir, '/srv');
    assert.equal(loadBase(key), null);
    saveBase(key, found);
    assert.deepEqual(loadBase(key).get('src/deep/a.js'), found.get('src/deep/a.js'));
  } finally {
    t.done();
  }
});

// A machine and a host with a site folder each: one file newer here, one only here, one only there, ignored ones.
function sites() {
  const local = demoLocal({
    tree: new Map([
      ['/', { kind: 'dir' }],
      ['/demo', { kind: 'dir' }],
      ['/demo/site', { kind: 'dir' }],
      ['/demo/site/.mooringignore', { kind: 'file', size: 6, text: '*.log\n' }],
      ['/demo/site/index.html', { kind: 'file', size: 100, modified: T + 60_000 }],
      ['/demo/site/css', { kind: 'dir' }],
      ['/demo/site/css/new.css', { kind: 'file', size: 5 }],
      ['/demo/site/debug.log', { kind: 'file', size: 9 }],
      ['/demo/site/node_modules', { kind: 'dir' }],
      ['/demo/site/node_modules/x.js', { kind: 'file', size: 9 }],
      ['/demo/site/same.txt', { kind: 'file', size: 3, modified: T + 9000, sum: 'abc' }],
    ]),
  });
  const host = demoSession({
    tree: new Map([
      ['/', { kind: 'dir' }],
      ['/home', { kind: 'dir' }],
      ['/home/demo', { kind: 'dir' }],
      ['/home/demo/site', { kind: 'dir' }],
      ['/home/demo/site/.mooringignore', { kind: 'file', size: 6 }],
      ['/home/demo/site/index.html', { kind: 'file', size: 90 }],
      ['/home/demo/site/old.txt', { kind: 'file', size: 7 }],
      ['/home/demo/site/same.txt', { kind: 'file', size: 3, sum: 'abc' }],
    ]),
  });
  return { local, host };
}

async function inSites(app) {
  await until(shows(app, 'demo  /home/demo'), 'the host connected');
  await type(app.stdin, '/lcd site');
  app.stdin.write(KEYS.enter);
  await until(shows(app, '/demo/site'), 'the local site');
  await type(app.stdin, '/cd site');
  app.stdin.write(KEYS.enter);
  await until(shows(app, '/home/demo/site'), 'the server site');
}

test('/sync shows the plan, asks, and sends what changed through the queue; --delete removes, --checksum compares', async () => {
  const app = start(sites());
  await inSites(app);
  await type(app.stdin, '/sync --checksum');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'Sync both ways: 2 uploads, 1 download?'), 'the question');
  const frame = app.lastFrame();
  assert.match(frame, /upload\s+newer here\s+index\.html/);
  assert.match(frame, /upload\s+new\s+css\/new\.css/);
  assert.match(frame, /download\s+new\s+old\.txt/);
  assert.ok(!frame.includes('debug.log') && !frame.includes('node_modules') && !frame.includes('same.txt'));
  // The checksum went over one ssh call, naming only the file that differs in time alone.
  assert.deepEqual(app.host.state.calls.filter((c) => c[0] === 'exec').map((c) => c[1]), ["cd '/home/demo/site' && sha256sum -- 'same.txt'"]);
  app.stdin.write(KEYS.enter);
  await until(() => app.host.state.tree.has('/home/demo/site/css/new.css') && app.host.state.calls.some((c) => c[0] === 'get'), 'the transfers');
  assert.equal(app.host.state.tree.get('/home/demo/site/index.html').size, 100);
  assert.ok(app.host.state.calls.some((c) => c[0] === 'mkdir' && c[1] === '/home/demo/site/css'));
  await until(shows(app, 'Transfers finished'), 'the queue done');
  // Up with --delete: what is only on the server goes, after the question (and without --checksum,
  // same.txt differs by its time alone, so it goes up too).
  await type(app.stdin, '/sync up --delete');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'Sync up: 1 upload, 1 deleted on demo?'), 'the delete question');
  app.stdin.write(KEYS.enter);
  await until(() => !app.host.state.tree.has('/home/demo/site/old.txt'), 'old.txt deleted');
  await type(app.stdin, '/sync sideways');
  app.stdin.write(KEYS.enter);
  await until(shows(app, "sideways isn't one of them"), 'the wrong word');
  app.unmount();
});

test('/watch uploads what changes here as it changes, shown in the header, until /watch off', async () => {
  const app = start(sites());
  await inSites(app);
  await type(app.stdin, '/watch');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'as it changes?'), 'the question');
  app.stdin.write(KEYS.enter);
  await until(shows(app, '⟳ watching site'), 'the header');
  app.local.state.tree.set('/demo/site/fresh.txt', { kind: 'file', size: 12 });
  app.local.state.changed('fresh.txt');
  app.local.state.changed('fresh.txt');
  app.local.state.changed('node_modules/x.js');
  await until(() => app.host.state.tree.has('/home/demo/site/fresh.txt'), 'the change uploaded');
  assert.equal(app.host.state.calls.filter((c) => c[0] === 'put').length, 1);
  await type(app.stdin, '/watch off');
  app.stdin.write(KEYS.enter);
  await until(() => !app.lastFrame().includes('⟳ watching'), 'the watch stopped');
  app.local.state.tree.set('/demo/site/later.txt', { kind: 'file', size: 1 });
  app.local.state.changed('later.txt');
  await new Promise((r) => setTimeout(r, 600));
  assert.ok(!app.host.state.tree.has('/home/demo/site/later.txt'));
  assert.equal(demoSum({ size: 3 }), demoSum({ sum: 3 }));
  app.unmount();
});
