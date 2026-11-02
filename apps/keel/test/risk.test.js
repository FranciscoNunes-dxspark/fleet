import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REASONS, RISK_WEIGHTS, isSource, isTest, pathKinds, reasonText, scorePr } from '../server/domain/risk.js';
import pt from '../client/src/locales/pt/risk.js';

const NOW = Date.parse('2026-11-01T12:00:00Z');
const D = 86_400_000;
const ann = { id: 'ann', uniqueName: 'ann@contoso.com', displayName: 'Ann' };
const pr = (extra = {}) => ({ author: ann, reviewers: [], ...extra });
const commit = (daysAgo, email = 'bob@contoso.com', message = 'Work') => ({ message, author: { name: email.split('@')[0], email, date: new Date(NOW - daysAgo * D).toISOString() } });
const ids = (r) => r.reasons.map((x) => x.id);

test('paths are told apart by their names', () => {
  assert.deepEqual(pathKinds('/package-lock.json'), ['dependencies']);
  assert.deepEqual(pathKinds('/src/Shop/Shop.csproj'), ['dependencies']);
  assert.deepEqual(pathKinds('/infra/main.bicep'), ['infrastructure']);
  assert.deepEqual(pathKinds('/deploy/network.tf'), ['infrastructure']);
  assert.deepEqual(pathKinds('/arm/azuredeploy.json'), ['infrastructure']);
  assert.deepEqual(pathKinds('/src/Data/Migrations/20261001_AddVat.cs'), ['migrations']);
  assert.deepEqual(pathKinds('/db/V12__orders.sql'), ['migrations']);
  assert.deepEqual(pathKinds('/azure-pipelines.yml'), ['pipelines']);
  assert.deepEqual(pathKinds('/.github/workflows/ci.yml'), ['pipelines']);
  assert.deepEqual(pathKinds('/src/auth/session.ts'), ['security']);
  assert.deepEqual(pathKinds('/src/Identity/TokenService.cs'), ['security']);
  assert.deepEqual(pathKinds('/src/author/list.ts'), []);
  assert.deepEqual(pathKinds('/README.md'), []);
  assert.equal(isTest('/tests/InvoiceTests.cs'), true);
  assert.equal(isTest('/src/cart.spec.ts'), true);
  assert.equal(isTest('/pkg/cart_test.go'), true);
  assert.equal(isSource('/src/cart.ts'), true);
  assert.equal(isSource('/src/cart.spec.ts'), false);
  assert.equal(isSource('/docs/cart.md'), false);
});

test('a small change with tests, by someone who knows the folder, is low', () => {
  const files = [{ path: '/src/cart/total.ts', lines: 20 }, { path: '/src/cart/total.test.ts', lines: 30 }];
  const r = scorePr({ pr: pr(), files, history: [{ dir: '/src/cart', commits: [commit(40, 'ann@contoso.com')] }], now: NOW });
  assert.equal(r.score, 0);
  assert.equal(r.level, 'low');
  assert.deepEqual(r.reasons, []);
});

test('the reasons add up to the score, biggest first, and say why', () => {
  const files = [
    { path: '/src/api/auth/login.cs' },
    { path: '/src/api/Orders.cs' },
    { path: '/infra/main.bicep' },
    { path: '/package-lock.json' },
    { path: '/azure-pipelines.yml' },
    { path: '/db/migrations/0042_vat.sql' },
  ];
  const history = [
    { dir: '/src/api', commits: Array.from({ length: 12 }, (_, i) => commit(i + 1)) },
    { dir: '/infra', commits: [commit(100)] },
  ];
  const reviewers = [{ id: 'g1', displayName: '[Shop]\\Owners', isRequired: true }, { id: 'u2', displayName: 'Bob', isRequired: true }, { ...ann, isRequired: true }];
  const r = scorePr({ pr: pr({ reviewers }), files, history, now: NOW });
  const w = RISK_WEIGHTS;
  // 6 files without line counts: 4; one hot folder: 4; five kinds; no tests; two owners (not the author); Ann new everywhere.
  const expected = 4 + 4 + w.dependencies + w.infrastructure + w.migrations + w.pipelines + w.security + w.noTests + 2 * w.ownerEach + w.newAuthor;
  assert.equal(r.score, Math.min(100, expected));
  assert.equal(r.level, 'high');
  assert.equal(r.reasons[0].points, 12);
  assert.ok(r.reasons.every((x, i) => i === 0 || r.reasons[i - 1].points >= x.points), 'biggest first');
  const text = r.reasons.map(reasonText);
  assert.ok(text.includes('6 files changed (line counts not known)'));
  assert.ok(text.includes('Changes a folder that changed often lately (commits in 30 days: /src/api 12)'));
  assert.ok(text.includes('Changes infrastructure as code (main.bicep)'));
  assert.ok(text.includes('Touches auth or security code (login.cs)'));
  assert.ok(text.includes('Changes 2 source files and no tests'));
  assert.ok(text.includes('Needs 2 code owners to approve'));
  assert.ok(text.includes('Ann has no commits in these folders in the last 180 days'));
});

test('line counts, when known, size it; the author having been in some folders halves that reason', () => {
  const files = Array.from({ length: 3 }, (_, i) => ({ path: `/src/${i ? 'a' : 'b'}/f${i}.md`, lines: 300 }));
  const history = [
    { dir: '/src/a', commits: [commit(3, 'ann@contoso.com'), commit(2, 'ann@contoso.com', 'Merged PR 12: x')] },
    { dir: '/src/b', commits: [commit(3, 'ann@contoso.com', 'Merged PR 13: y')] },
  ];
  const r = scorePr({ pr: pr(), files, history, now: NOW });
  assert.deepEqual(ids(r), ['lines', 'partlyNewAuthor']);
  assert.equal(r.reasons[0].points, 15);
  assert.equal(reasonText(r.reasons[0]), '900 lines changed in 3 files');
  assert.equal(reasonText(r.reasons[1]), 'Ann has no commits in 1 of these 2 folders in the last 180 days');
  assert.equal(r.score, 20);
  assert.equal(r.level, 'low');
});

test('the score stops at 100, and files that could not be read say so', () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ path: `/src/auth/f${i}.cs`, lines: 100 }));
  const extra = ['/main.tf', '/package.json', '/migrations/1.sql', '/azure-pipelines.yml'].map((path) => ({ path, lines: 10 }));
  const reviewers = Array.from({ length: 5 }, (_, i) => ({ id: `o${i}`, isRequired: true }));
  const r = scorePr({ pr: pr({ reviewers }), files: [...many, ...extra], history: [{ dir: '/src/auth', commits: Array.from({ length: 30 }, (_, i) => commit(i % 20)) }], now: NOW });
  assert.equal(r.score, 100);
  const none = scorePr({ pr: pr({ reviewers: [{ id: 'o', isRequired: true }] }), files: null, now: NOW });
  assert.deepEqual(ids(none), ['owners', 'noFiles']);
  assert.equal(none.score, RISK_WEIGHTS.ownerEach);
});

test('every reason has its Portuguese', () => {
  for (const text of Object.values(REASONS)) assert.ok(pt[text], `no Portuguese for "${text}"`);
});
