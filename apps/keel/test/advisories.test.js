import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { advisoryAttention, atLeast, findingsOf, fixedIn, mergeAdvisories, parseLockFile, pickLockFiles, uniquePackages } from '../server/domain/advisories.js';
import { diffSnapshots } from '../server/domain/changes.js';
import { channelEvents, eventMessage } from '../server/domain/messages.js';
import { PUSH_CATEGORIES, openUrl, pushMessages, wanted } from '../server/push.js';
import { translator } from '../server/i18n.js';
import { createAdvisoryWatch } from '../server/advisories.js';
import { DEMO_FILES, DEMO_RECORDS, createMockOsvFetch } from '../server/mock/advisories.js';
import { createMockProvider } from '../server/mock/provider.js';
import { createService } from '../server/service.js';
import { DEFAULT_SETTINGS } from '../server/settings.js';

const DAY = 86_400_000;
const record = (id) => DEMO_RECORDS.find((r) => r.id === id);
const repo = { projectId: 'p-commerce', projectName: 'Commerce', id: 'r-storefront-web', name: 'storefront-web' };

test('advisories: lock files are picked from a repository listing, shallowest first, never in node_modules', () => {
  const { files, more } = pickLockFiles([
    '/src/web/package-lock.json', '/package-lock.json', '/node_modules/x/package-lock.json', '/apps/node_modules/y/npm-shrinkwrap.json',
    '/src/Api/packages.lock.json', '/yarn.lock', '/pnpm-lock.yaml', '/package.json', '/docs/package-lock.json.bak',
  ]);
  assert.deepEqual(files, ['/package-lock.json', '/src/Api/packages.lock.json', '/src/web/package-lock.json']);
  assert.equal(more, false);
  const many = Array.from({ length: 60 }, (_, i) => `/p${String(i).padStart(2, '0')}/package-lock.json`);
  const capped = pickLockFiles(many);
  assert.equal(capped.files.length, 50);
  assert.equal(capped.more, true);
});

test('advisories: the fix is the end of the range the version is in', () => {
  const minimist = record('GHSA-xvch-5gv4-984h');
  assert.equal(fixedIn(minimist, { ecosystem: 'npm', name: 'minimist', version: '1.2.5' }), '1.2.6');
  assert.equal(fixedIn(minimist, { ecosystem: 'npm', name: 'minimist', version: '0.1.0' }), '0.2.4');
  assert.equal(fixedIn(minimist, { ecosystem: 'npm', name: 'other', version: '1.2.5' }), null);
  // NuGet names compare without case.
  assert.equal(fixedIn(record('GHSA-5crp-9r3c-p9vr'), { ecosystem: 'NuGet', name: 'newtonsoft.json', version: '12.0.1' }), '13.0.1');
  assert.ok(atLeast('critical', 'high') && atLeast('high', 'high') && !atLeast('medium', 'high') && atLeast('medium', 'medium') && !atLeast('unknown', 'low'));
});

test('advisories: findings from the demo lock files, worst first', () => {
  const files = Object.entries({ ...DEMO_FILES['storefront-web'], ...DEMO_FILES['checkout-api'] })
    .filter(([p]) => pickLockFiles([p]).files.length)
    .map(([p, text]) => ({ path: p, packages: parseLockFile(p, text) }));
  const packages = uniquePackages(files);
  const ids = new Map([
    [packages.find((p) => p.name === 'lodash').key, ['GHSA-35jh-r3h4-6jhm']],
    [packages.find((p) => p.name === 'minimist').key, ['GHSA-xvch-5gv4-984h']],
    [packages.find((p) => p.name === 'Newtonsoft.Json').key, ['GHSA-5crp-9r3c-p9vr']],
  ]);
  const found = findingsOf(packages, ids, new Map(DEMO_RECORDS.map((r) => [r.id, r])));
  assert.deepEqual(found.map((f) => [f.package, f.severity, f.fixed, f.path]), [
    ['minimist', 'critical', '1.2.6', '/package-lock.json'],
    ['Newtonsoft.Json', 'high', '13.0.1', '/src/Checkout.Api/packages.lock.json'],
    ['lodash', 'high', '4.17.21', '/package-lock.json'],
  ]);
  assert.equal(found[0].direct, false);
  assert.equal(found[2].direct, true);
});

test('advisories: the first look is a baseline, later looks tell what is new', () => {
  const lodash = { id: 'GHSA-35jh-r3h4-6jhm', ecosystem: 'npm', package: 'lodash', version: '4.17.20', severity: 'high', path: '/package-lock.json' };
  const minimist = { id: 'GHSA-xvch-5gv4-984h', ecosystem: 'npm', package: 'minimist', version: '1.2.5', severity: 'critical', path: '/package-lock.json' };
  const first = mergeAdvisories(null, [lodash], '2026-11-01T00:00:00.000Z');
  assert.equal(first.baseline, true);
  assert.deepEqual(first.added, []);
  assert.equal(first.advisories[0].baseline, true);
  // A failed first try (no checkedAt yet) is still a baseline.
  assert.equal(mergeAdvisories({ triedAt: 'x', error: 'boom' }, [lodash]).baseline, true);

  const entry = { checkedAt: '2026-11-01T00:00:00.000Z', advisories: first.advisories };
  const second = mergeAdvisories(entry, [minimist, lodash], '2026-11-02T00:00:00.000Z');
  assert.deepEqual(second.added.map((a) => a.package), ['minimist']);
  assert.equal(second.advisories.find((a) => a.package === 'lodash').firstSeen, '2026-11-01T00:00:00.000Z');
  assert.equal(second.advisories.find((a) => a.package === 'lodash').baseline, true);
  assert.equal(second.advisories.find((a) => a.package === 'minimist').firstSeen, '2026-11-02T00:00:00.000Z');
  // Fixed, then back: new again.
  const third = mergeAdvisories({ checkedAt: 'y', advisories: [] }, [lodash], 'z');
  assert.deepEqual(third.added.map((a) => a.package), ['lodash']);
});

test('advisories: new ones become urgent inbox entries, from the chosen severity, for a week', () => {
  const now = Date.parse('2026-11-02T12:00:00Z');
  const a = (over) => ({ id: 'GHSA-1', ecosystem: 'npm', package: 'lodash', version: '4.17.20', severity: 'high', summary: 'Command Injection in lodash', fixed: '4.17.21', path: '/package-lock.json', firstSeen: '2026-11-02T08:00:00Z', ...over });
  const entry = { advisories: [a(), a({ id: 'GHSA-2', baseline: true }), a({ id: 'GHSA-3', severity: 'medium' }), a({ id: 'GHSA-4', firstSeen: '2026-10-20T00:00:00Z' }), a({ id: 'GHSA-5', severity: 'critical', fixed: null })] };
  const items = advisoryAttention([{ repo, entry }], { now });
  assert.deepEqual(items.map((i) => i.key), ['advisory:p-commerce/r-storefront-web:GHSA-1:npm:lodash@4.17.20', 'advisory:p-commerce/r-storefront-web:GHSA-5:npm:lodash@4.17.20']);
  assert.deepEqual(items[0], {
    key: 'advisory:p-commerce/r-storefront-web:GHSA-1:npm:lodash@4.17.20',
    kind: 'advisory',
    severity: 'high',
    title: 'lodash 4.17.20 has a high-severity security advisory',
    context: 'Commerce / storefront-web · /package-lock.json',
    reasons: [{ code: 'advisory', severity: 'high', text: 'GHSA-1: Command Injection in lodash' }, { code: 'advisory-fix', severity: 'medium', text: 'Fixed in 4.17.21' }],
    at: '2026-11-02T08:00:00Z',
    target: { type: 'advisory', projectId: 'p-commerce', repoId: 'r-storefront-web' },
    webUrl: 'https://osv.dev/vulnerability/GHSA-1',
  });
  assert.equal(items[1].title, 'lodash 4.17.20 has a critical security advisory');
  assert.equal(items[1].reasons[1].text, 'No fixed version yet');
  assert.equal(advisoryAttention([{ repo, entry }], { now, minSeverity: 'medium' }).length, 3);
  assert.equal(advisoryAttention([{ repo, entry }], { now, minSeverity: 'critical' }).length, 1);
});

test('advisories: the notes every delivery makes of a new entry', () => {
  const [item] = advisoryAttention([{ repo, entry: { advisories: [{ id: 'GHSA-35jh-r3h4-6jhm', ecosystem: 'npm', package: 'lodash', version: '4.17.20', severity: 'high', summary: 'Command Injection in lodash', fixed: '4.17.21', path: '/package-lock.json', firstSeen: new Date().toISOString() }] } }]);
  const snap = (attention) => ({ attention, myPrs: [], runs: [], schedules: [] });
  // Live updates and push: a new urgent inbox entry, in its own category.
  const notes = diffSnapshots(snap([]), snap([item]));
  assert.equal(notes.length, 1);
  assert.equal(notes[0].category, 'advisory');
  assert.equal(notes[0].key, `attention:${item.key}`);
  assert.ok(PUSH_CATEGORIES.includes('advisory'));
  assert.ok(wanted(notes[0], {}), 'on unless turned off');
  assert.ok(!wanted(notes[0], { advisory: false }));
  const [pt] = pushMessages(notes, translator('pt'));
  assert.equal(pt.title, 'lodash 4.17.20 tem um aviso de segurança de gravidade alta');
  assert.equal(pt.url, '/insights?tab=advisories');
  assert.equal(openUrl(item.target), '/insights?tab=advisories');
  // Teams and Slack: channels that want advisories post it once.
  const first = channelEvents(null, [item], ['production', 'advisory']);
  assert.deepEqual(first.announce, []);
  const next = channelEvents(first.seen, [item], ['production', 'advisory']);
  assert.deepEqual(next.announce, []);
  assert.deepEqual(channelEvents({}, [item], ['advisory']).announce, [item]);
  assert.deepEqual(channelEvents({}, [item], ['production']).announce, []);
  const post = eventMessage(item, translator('pt'), 'https://keel.example.com');
  assert.equal(post.title, 'lodash 4.17.20 tem um aviso de segurança de gravidade alta');
  assert.deepEqual(post.links, [{ label: 'Abrir o aviso', url: 'https://osv.dev/vulnerability/GHSA-35jh-r3h4-6jhm' }, { label: 'Abrir no Keel', url: 'https://keel.example.com/insights?tab=advisories' }]);
});

const memoryStore = (extra = {}) => {
  let current = { ...structuredClone(DEFAULT_SETTINGS), projects: { 'p-commerce': { name: 'Commerce', tracked: true, repos: 'all', teams: [] } }, ...extra };
  return { load: async () => current, save: async (patch) => (current = { ...current, ...patch }) };
};

test('advisories: the watch end to end, on the demo organization and a fake OSV', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-advisories-'));
  const provider = createMockProvider();
  let watch = null;
  const settings = memoryStore();
  const service = createService({ provider, settings, advisories: { entryOf: (r) => watch.entryOf(r), checkNow: (...a) => watch.checkNow(...a) } });
  // OSV doesn't know about minimist yet on the first day.
  const firstFetch = createMockOsvFetch({ records: DEMO_RECORDS.filter((r) => r.id !== 'GHSA-xvch-5gv4-984h') });
  watch = createAdvisoryWatch({ dataDir: dir, mock: true, resolveService: () => service, fetchImpl: firstFetch, autostart: false });
  await watch.tick();

  const store = JSON.parse(fs.readFileSync(path.join(dir, 'advisories.mock.json'), 'utf8'));
  const web = store.repos['p-commerce/r-storefront-web'];
  assert.deepEqual(web.lockFiles, ['/package-lock.json'], 'the copy inside node_modules is never read');
  assert.deepEqual(web.advisories.map((a) => [a.package, a.baseline]), [['lodash', true]]);
  assert.deepEqual(store.repos['p-commerce/r-checkout-api'].advisories.map((a) => a.package), ['Newtonsoft.Json']);
  assert.deepEqual(store.repos['p-commerce/r-payments-service'].lockFiles, []);
  assert.ok(!Object.keys(store.repos).some((k) => k.startsWith('p-platform')), 'only tracked projects');
  // Only package names, versions and ecosystems go to OSV.
  const asked = firstFetch.calls.filter((c) => c.body).flatMap((c) => c.body.queries);
  assert.ok(asked.length > 0);
  for (const q of asked) {
    assert.deepEqual(Object.keys(q).sort(), ['package', 'version']);
    assert.deepEqual(Object.keys(q.package).sort(), ['ecosystem', 'name']);
  }
  assert.ok(firstFetch.calls.every((c) => c.url.startsWith('https://api.osv.dev/')));

  // The baseline tells nobody.
  const before = await service.snapshot();
  assert.equal(before.attention.filter((i) => i.kind === 'advisory').length, 0);

  // Checked again before a day has passed: nothing to do.
  const calls = firstFetch.calls.length;
  await watch.tick();
  assert.equal(firstFetch.calls.length, calls);

  // A day later OSV has the minimist advisory: one new, urgent inbox entry, and a note for it.
  const later = Date.now() + 2 * DAY;
  // A new process: the last one's claim to run the watch is let go of, as it would go stale.
  fs.rmSync(path.join(dir, 'advisory-runner.mock.json'));
  watch = createAdvisoryWatch({ dataDir: dir, mock: true, resolveService: () => service, fetchImpl: createMockOsvFetch(), autostart: false, now: () => later });
  await watch.tick();
  const after = await service.snapshot();
  const fresh = after.attention.filter((i) => i.kind === 'advisory');
  assert.deepEqual(fresh.map((i) => i.title), ['minimist 1.2.5 has a critical security advisory']);
  const notes = diffSnapshots(before, after).filter((n) => n.category === 'advisory');
  assert.equal(notes.length, 1);

  // The page's view: worst first, and "check now" waits ten minutes between reads.
  const view = await service.advisories();
  assert.equal(view.enabled, true);
  assert.equal(view.minSeverity, 'high');
  const row = view.repos.find((r) => r.repoId === 'r-storefront-web');
  assert.deepEqual(row.advisories.map((a) => a.severity), ['critical', 'high']);
  await assert.rejects(service.checkAdvisories('p-commerce', 'r-storefront-web'), (e) => e.status === 429);
  await assert.rejects(service.checkAdvisories('p-platform', 'r-api-gateway'), (e) => e.status === 400, 'not a tracked repo');

  // Turned off: no inbox entries, and the watch skips this person.
  await settings.save({ advisories: { enabled: false, minSeverity: 'high' } });
  assert.equal((await service.attention()).items.filter((i) => i.kind === 'advisory').length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('advisories: GitHub repositories are read through the git tree and contents', async () => {
  const { createMockGithub } = await import('../server/mock/github.js');
  const gh = createMockGithub();
  const files = await gh.listRepoFiles('gh-octo-demo', 'web-app', 'main');
  assert.ok(files.includes('/package-lock.json'));
  const text = await gh.getRepoFileText('gh-octo-demo', 'web-app', '/package-lock.json', 'main');
  assert.ok(parseLockFile('/package-lock.json', text).some((p) => p.name === 'lodash' && p.version === '4.17.20'));
});
