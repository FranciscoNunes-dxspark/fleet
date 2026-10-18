import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMultiService } from '../server/multiorg.js';
import { orgKeyOf, normalizeOrgUrl } from '../server/orgs.js';
import { createAccounts } from '../server/accounts.js';

const A = { key: 'contoso', name: 'contoso', url: 'https://dev.azure.com/contoso', primary: true };
const B = { key: 'other', name: 'Other', url: 'https://dev.azure.com/other', primary: false };

// A tiny stand-in for one organization's service.
const fake = (org, { fail = false } = {}) => ({
  org,
  async allProjects() { return [{ id: `${org.key}-p`, name: 'Web' }]; },
  async workItem(id) { return { id, projectName: `${org.key} project`, parent: null, children: [{ id: id + 1 }] }; },
  async attention() {
    if (fail) throw new Error('token expired');
    return { items: [{ key: `${org.primary ? '' : `${org.key}/`}wi:7`, severity: org.primary ? 'medium' : 'high', target: { type: 'workitem', id: 7 } }], snoozedCount: 1, summary: { myReviews: 2, approvals: 1 } };
  },
  async pipelineRuns(projectId, definitionId) { return { pipeline: null, runs: [{ projectId, definitionId }] }; },
  async branches() { return [{ name: 'main' }, { name: 'develop' }]; },
  async decideApproval(kind, id) {
    if (org.primary) throw Object.assign(new Error('not pending here'), { status: 404 });
    return `${org.key}:${kind}:${id}`;
  },
  async meta() {
    if (fail) throw new Error('token expired'); // an expired token fails every call
    return { me: { displayName: 'Lead' }, trackedProjects: [{ id: `${org.key}-p`, name: 'Web' }] };
  },
});

test('organizations: keys from addresses, and only organization addresses accepted', () => {
  assert.equal(orgKeyOf('https://dev.azure.com/Contoso'), 'contoso');
  assert.equal(orgKeyOf('https://acme.visualstudio.com'), 'acme');
  assert.equal(normalizeOrgUrl('https://dev.azure.com/acme/Project/_git/x'), 'https://dev.azure.com/acme');
  assert.throws(() => normalizeOrgUrl('https://dev.azure.com/'), /organization name/);
  assert.throws(() => normalizeOrgUrl('https://user:pw@dev.azure.com/acme'), /without credentials/);
});

test('one organization: the service itself, unchanged', () => {
  const svc = fake(A);
  assert.equal(createMultiService([{ org: A, service: svc }]), svc);
});

test('several organizations: merged lists, routed calls, work items by org', async () => {
  const multi = createMultiService([{ org: A, service: fake(A) }, { org: B, service: fake(B) }]);

  const att = await multi.attention();
  assert.deepEqual(att.items.map((i) => [i.org, i.key, i.target.org]), [['other', 'other/wi:7', 'other'], ['contoso', 'wi:7', 'contoso']]);
  assert.deepEqual(att.summary, { myReviews: 4, approvals: 2 });
  assert.equal(att.snoozedCount, 2);

  const w = await multi.workItem(7, 'other');
  assert.deepEqual([w.org, w.projectName, w.children[0].org], ['other', 'other project', 'other']);
  assert.equal((await multi.workItem(7)).org, 'contoso'); // no org: the primary

  const runs = await multi.pipelineRuns('other-p', 3);
  assert.equal(runs.org, 'other');
  await assert.rejects(multi.pipelineRuns('nowhere', 3), /Unknown project/);

  // An approval pending in the second organization is found there.
  assert.equal(await multi.decideApproval('yaml', 'x1', {}), 'other:yaml:x1');

  const meta = await multi.meta();
  assert.deepEqual(meta.orgs.map((o) => o.key), ['contoso', 'other']);
  assert.deepEqual(meta.trackedProjects.map((p) => p.org), ['contoso', 'other']);
});

test('a failing secondary organization is left out and reported; a failing primary fails', async () => {
  const multi = createMultiService([{ org: A, service: fake(A) }, { org: B, service: fake(B, { fail: true }) }]);
  const att = await multi.attention();
  assert.deepEqual(att.items.map((i) => i.org), ['contoso']);
  assert.equal((await multi.meta()).orgs.find((o) => o.key === 'other').error, 'token expired');

  const broken = createMultiService([{ org: A, service: fake(A, { fail: true }) }, { org: B, service: fake(B) }]);
  await assert.rejects(broken.attention(), /token expired/);
});

test('accounts: a token saved before organizations belongs to the primary one', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'keel-orgs-')), 'users.json');
  fs.writeFileSync(file, JSON.stringify({ users: [{ id: 'u1', email: 'a@x.com', name: 'A', role: 'admin', passwordHash: 'x', pat: 'ENCRYPTED', azdoId: 'az-1', azdoName: 'Lead' }] }));
  const acc = createAccounts(file, { primaryOrg: 'contoso' });
  const saved = JSON.parse(fs.readFileSync(file, 'utf8')).users[0];
  assert.deepEqual(saved.tokens, { contoso: 'ENCRYPTED' });
  assert.deepEqual(saved.azdo, { contoso: { id: 'az-1', name: 'Lead' } });
  assert.equal(saved.pat, undefined);
  assert.equal(acc.hasToken('u1'), true);
  assert.equal(acc.hasToken('u1', 'other'), false);
  assert.equal(acc.get('u1').azdoName, 'Lead');
  assert.deepEqual(acc.get('u1').orgTokens, ['contoso']);
});

test('several organizations: a list answered by one organization stays a list', async () => {
  const multi = createMultiService([{ org: A, service: fake(A) }, { org: B, service: fake(B) }]);
  const branches = await multi.branches('other-p', 'repo');
  assert.ok(Array.isArray(branches), 'the New pull request panel calls .some() on it');
  assert.deepEqual(branches, [{ name: 'main', org: 'other' }, { name: 'develop', org: 'other' }]);
});
