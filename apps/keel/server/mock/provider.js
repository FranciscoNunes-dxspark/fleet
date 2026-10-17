import { stageSummary } from '../domain/releases.js';
import { demoFile } from './files.js';

// Demo provider: a deterministic, in-memory Azure DevOps organization.
// It implements exactly the same methods and return shapes as
// server/azdo/provider.js, and write actions really mutate the data so the
// whole UI can be exercised without credentials.

const ORG = 'https://dev.azure.com/contoso-demo';
const NOW = Date.now();
const H = 3_600_000;
const D = 24 * H;
const iso = (ms) => new Date(ms).toISOString();
const ago = (ms) => iso(NOW - ms);

function rng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(42);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const between = (a, b) => a + rand() * (b - a);
const sample = (arr, n) => [...arr].sort(() => rand() - 0.5).slice(0, n);

const person = (id, displayName, email) => ({ id, displayName, uniqueName: email, imageUrl: null, isContainer: false });
const ME = person('u-lead', 'You (Tech Lead)', 'lead@contoso-demo.com');
const PEOPLE = [
  ME,
  person('u-priya', 'Priya Shah', 'priya@contoso-demo.com'),
  person('u-marcus', 'Marcus Chen', 'marcus@contoso-demo.com'),
  person('u-sofia', 'Sofia Alvarez', 'sofia@contoso-demo.com'),
  person('u-dan', "Dan O'Brien", 'dan@contoso-demo.com'),
  person('u-aisha', 'Aisha Bello', 'aisha@contoso-demo.com'),
  person('u-tom', 'Tom Kowalski', 'tom@contoso-demo.com'),
  person('u-lena', 'Lena Fischer', 'lena@contoso-demo.com'),
];
const DEVS = PEOPLE.slice(1);

const AGILE = {
  'User Story': [['New', 'Proposed'], ['Active', 'InProgress'], ['Resolved', 'Resolved'], ['Closed', 'Completed'], ['Removed', 'Removed']],
  Bug: [['New', 'Proposed'], ['Active', 'InProgress'], ['Resolved', 'Resolved'], ['Closed', 'Completed'], ['Removed', 'Removed']],
  Task: [['New', 'Proposed'], ['Active', 'InProgress'], ['Closed', 'Completed'], ['Removed', 'Removed']],
  Feature: [['New', 'Proposed'], ['Active', 'InProgress'], ['Resolved', 'Resolved'], ['Closed', 'Completed'], ['Removed', 'Removed']],
  Epic: [['New', 'Proposed'], ['Active', 'InProgress'], ['Resolved', 'Resolved'], ['Closed', 'Completed'], ['Removed', 'Removed']],
};
const SCRUM = {
  'Product Backlog Item': [['New', 'Proposed'], ['Approved', 'Proposed'], ['Committed', 'InProgress'], ['Done', 'Completed'], ['Removed', 'Removed']],
  Bug: [['New', 'Proposed'], ['Approved', 'Proposed'], ['Committed', 'InProgress'], ['Done', 'Completed'], ['Removed', 'Removed']],
  Task: [['To Do', 'Proposed'], ['In Progress', 'InProgress'], ['Done', 'Completed'], ['Removed', 'Removed']],
  Feature: [['New', 'Proposed'], ['In Progress', 'InProgress'], ['Done', 'Completed'], ['Removed', 'Removed']],
  Epic: [['New', 'Proposed'], ['In Progress', 'InProgress'], ['Done', 'Completed'], ['Removed', 'Removed']],
};

const EPICS = {
  Commerce: [['Checkout 2.0', ['Guest checkout', 'Payments resilience', 'Refunds']], ['Search & discovery', ['Typo-tolerant search', 'Catalog performance']]],
  Platform: [['Zero-trust identity', ['Enterprise SSO', 'Login protection']], ['Observability', ['Distributed tracing', 'Audit trail']]],
  Mobile: [['Mobile 3.0', ['Offline mode', 'Theming']], ['Engagement', ['Push notifications']]],
};
const toStateMap = (proc) => Object.fromEntries(Object.entries(proc).map(([t, s]) => [t, s.map(([name, category]) => ({ name, category }))]));

const PROJECTS = [
  { id: 'p-commerce', name: 'Commerce', process: AGILE, story: 'User Story', repos: ['storefront-web', 'checkout-api', 'payments-service', 'catalog-service'] },
  { id: 'p-platform', name: 'Platform', process: AGILE, story: 'User Story', repos: ['identity-service', 'api-gateway', 'infra-terraform', 'shared-libs'] },
  { id: 'p-mobile', name: 'Mobile', process: SCRUM, story: 'Product Backlog Item', repos: ['mobile-app', 'notifications-service'] },
].map((p) => ({
  ...p,
  stateMap: toStateMap(p.process),
  team: { id: `t-${p.id}`, name: `${p.name} Team` },
  group: { id: `g-${p.id}`, displayName: `[${p.name}]\\${p.name} Team`, uniqueName: '', imageUrl: null, isContainer: true },
  repoObjs: p.repos.map((r) => ({
    id: `r-${r}`,
    name: r,
    projectId: p.id,
    projectName: p.name,
    defaultBranch: r === 'infra-terraform' ? 'master' : 'main',
    webUrl: `${ORG}/${p.name}/_git/${r}`,
  })),
}));
const projectById = (id) => PROJECTS.find((p) => p.id === id || p.name === id);
const ALL_REPOS = PROJECTS.flatMap((p) => p.repoObjs);

const SPRINTS = (p) => ({
  previous: { id: `${p.id}-s41`, name: 'Sprint 41', path: `${p.name}\\Sprint 41`, startDate: ago(20 * D), finishDate: ago(7 * D) },
  current: { id: `${p.id}-s42`, name: 'Sprint 42', path: `${p.name}\\Sprint 42`, startDate: ago(6 * D), finishDate: iso(NOW + 8 * D) },
});

// ---------------------------------------------------------------- work items
const STORY_TITLES = [
  'Guest checkout with saved addresses', 'Paginate order history API', 'Apple Pay support on web', 'Rate limit login attempts per IP',
  'Product search typo tolerance', 'Migrate catalog images to CDN', 'Refund flow for partial shipments', 'SSO with customer Azure AD tenants',
  'Push notification preferences screen', 'Offline cart sync for mobile', 'Export invoices as PDF', 'Feature flags for promo banners',
  'Audit log for admin actions', 'Terraform module for Redis cache', 'Upgrade shared-libs to .NET 9', 'Dark mode for mobile app',
  'Inventory reservation timeout', 'Gateway request tracing headers', 'Split payments-service DB schema', 'Accessibility pass on checkout',
];
const BUG_TITLES = [
  'Checkout total rounds incorrectly for JPY', 'Token refresh loop after password change', 'Crash on Android 14 when opening camera',
  'Duplicate webhook delivery on retry', 'Search returns archived products', 'Gateway 502 under load on /orders', 'Coupon applied twice on reload',
  'Push notifications not delivered on iOS 18', 'Memory leak in catalog image resizer', 'Timezone shift in order export',
];
const TASK_TITLES = ['Write integration tests', 'Update API contract', 'Code review follow-ups', 'Add telemetry', 'Update runbook', 'Spike: evaluate approach', 'DB migration script', 'UI polish'];

const workItems = new Map();
let nextWi = 4100;

/** Some items carry files: bugs a screenshot and a log, a few others a spreadsheet. By id, so the demo stays the same. */
function demoAttachments(id, type, created) {
  const file = (n, name, by) => ({
    id: `00000000-0000-4000-8000-${String(id * 10 + n).padStart(12, '0')}`,
    name,
    size: demoFile(name, id).length,
    comment: '',
    addedAt: iso(created + (n + 1) * H),
    by,
  });
  if (type === 'Bug' && id % 2 === 0) return [file(1, 'checkout-error.png'), file(2, 'gateway.log')];
  if (type === 'Bug') return [file(1, 'screenshot.png')];
  if (id % 5 === 0) return [file(1, 'invoice-sample.csv')];
  return [];
}

// Azure DevOps' default type colors, so the demo looks like a real organization.
const TYPE_COLORS = { Epic: '#FF7B00', Feature: '#773B93', 'User Story': '#009CCC', 'Product Backlog Item': '#009CCC', Bug: '#CC293D', Task: '#F2CB1D' };

function addWorkItem(p, { type, title, stateIdx, sprint, assignedTo, priority, severity, tags = [], points, remaining, ageDays, stateDays, parentId, blocked }) {
  const states = p.process[type];
  const [state, stateCategory] = states[stateIdx];
  const id = nextWi++;
  const created = NOW - ageDays * D;
  const stateChanged = NOW - Math.min(stateDays, ageDays) * D;
  const item = {
    id,
    rev: 3,
    projectName: p.name,
    type,
    typeColor: TYPE_COLORS[type] || null,
    backlogOrder: (priority || 2) * 100_000 + id * 10,
    title,
    state,
    stateCategory,
    reason: null,
    assignedTo,
    createdBy: pick(PEOPLE),
    iterationPath: sprint ? sprint.path : p.name,
    areaPath: p.name,
    tags,
    priority,
    severity: type === 'Bug' ? severity : null,
    storyPoints: type === 'Task' ? null : points,
    remainingWork: type === 'Task' ? remaining : null,
    blocked: !!blocked,
    parentId: parentId ?? null,
    createdAt: iso(created),
    changedAt: iso(Math.max(stateChanged, NOW - between(0, stateDays) * D)),
    stateChangedAt: iso(stateChanged),
    closedAt: stateCategory === 'Completed' ? iso(stateChanged) : null,
    webUrl: `${ORG}/${p.name}/_workitems/edit/${id}`,
    _description: `${title}.\n\nAs a customer I want this to work reliably so that I can complete my task without contacting support.`,
    _acceptance: '- Happy path covered by **automated tests**\n- Telemetry added\n- Docs updated',
    _comments: rand() < 0.5 ? [{ author: pick(DEVS), text: 'Picked this up, will update by EOD.', createdAt: iso(stateChanged + H) }] : [],
    _prs: [],
    _attachments: demoAttachments(id, type, created),
  };
  workItems.set(id, item);
  return item;
}

for (const p of PROJECTS) {
  const { previous, current } = SPRINTS(p);
  const features = [];
  EPICS[p.name].forEach(([epicTitle, featureTitles], ei) => {
    const epic = addWorkItem(p, { type: 'Epic', title: epicTitle, stateIdx: 1, assignedTo: ME, priority: ei + 1, ageDays: 120, stateDays: 60 });
    featureTitles.forEach((ft, fi) => {
      const done = ei === 0 && fi === 0 && rand() < 0.5;
      features.push(addWorkItem(p, {
        type: 'Feature', title: ft, parentId: epic.id, stateIdx: done ? p.process.Feature.findIndex(([, c]) => c === 'Completed') : fi === 0 ? 1 : 0,
        assignedTo: pick(DEVS), priority: 2, ageDays: 90, stateDays: between(3, 30),
      }));
    });
  });
  const stories = [...STORY_TITLES].sort(() => rand() - 0.5).slice(0, 9);
  stories.forEach((title, i) => {
    const sprint = i < 6 ? current : i < 8 ? previous : null;
    const stateIdx = sprint === previous ? 3 : sprint ? [0, 1, 1, 2, 3, 1][i] ?? 1 : 0;
    const assignedTo = sprint ? pick(DEVS) : rand() < 0.5 ? null : pick(DEVS);
    const story = addWorkItem(p, {
      type: p.story, title, stateIdx, sprint, assignedTo, priority: pick([1, 2, 2, 3]), points: pick([1, 2, 3, 5, 8]),
      ageDays: between(8, 40), stateDays: stateIdx === 1 ? between(0.5, 9) : between(1, 6),
      tags: i === 2 ? ['Blocked', 'needs-design'] : i === 4 ? ['tech-debt'] : [],
      parentId: i < 8 ? features[i % features.length].id : undefined,
    });
    if (sprint === current) {
      const tasks = sample(TASK_TITLES, 2 + Math.floor(rand() * 2));
      tasks.forEach((t, j) => {
        const done = story.stateCategory === 'Completed' || j === 0;
        const taskStates = p.process.Task;
        addWorkItem(p, {
          type: 'Task', title: `${t} — ${title.split(' ').slice(0, 3).join(' ')}`, sprint,
          stateIdx: done ? taskStates.findIndex(([, c]) => c === 'Completed') : j === 1 ? 1 : 0,
          assignedTo: story.assignedTo, priority: 2, remaining: done ? 0 : pick([2, 4, 6, 8]), ageDays: 6, stateDays: between(0.2, 5), parentId: story.id,
        });
      });
    }
  });
  const bugs = [...BUG_TITLES].sort(() => rand() - 0.5).slice(0, 5);
  bugs.forEach((title, i) => {
    const sprint = i < 3 ? current : null;
    addWorkItem(p, {
      type: 'Bug', title, sprint, stateIdx: [1, 0, 2, 0, 0][i], priority: [1, 1, 2, 3, 2][i], severity: ['1 - Critical', '2 - High', '3 - Medium', '3 - Medium', '4 - Low'][i],
      assignedTo: i === 1 ? null : pick(DEVS), points: pick([1, 2, 3]), ageDays: between(1, 25), stateDays: i === 0 ? 7.5 : between(0.5, 4),
      tags: i === 3 ? ['customer-reported'] : [], blocked: p.name === 'Platform' && i === 0,
    });
  });
}
// A few items for the lead personally.
for (const p of PROJECTS.slice(0, 2)) {
  addWorkItem(p, { type: 'Task', title: `Architecture review: ${p.name} Q4 roadmap`, sprint: SPRINTS(p).current, stateIdx: 1, assignedTo: ME, priority: 2, remaining: 6, ageDays: 5, stateDays: 2 });
}

// ------------------------------------------------------------- pull requests
const PR_TITLES = [
  'Add retry policy to payment provider client', 'Refactor cart totals into pricing module', 'Fix flaky checkout e2e test', 'Introduce OpenTelemetry tracing',
  'Bump dependencies (security patches)', 'Implement refund endpoint', 'Cache product listings in Redis', 'Remove legacy v1 auth middleware',
  'Add PDF invoice export', 'Fix timezone handling in order export', 'Paginate order history', 'Mobile: dark mode theme tokens',
  'Mobile: offline cart persistence', 'Terraform: Redis module + outputs', 'Gateway: propagate traceparent header', 'Identity: rate limit login by IP',
  'Catalog: typo-tolerant search analyzer', 'Notifications: APNs token refresh', 'Shared-libs: .NET 9 upgrade', 'Split payments schema (part 1)',
  'Feature flags for promo banners', 'Admin audit log events', 'Fix duplicate webhook delivery', 'Accessibility fixes on checkout form',
  'Mobile: camera permission crash on Android 14', 'Gateway: 502s under load — tune keepalive', 'Coupon idempotency key', 'Image resizer memory leak fix',
];
const BRANCH = (t) => `feature/${t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)}`;

const prs = new Map();
let nextPr = 812;

function makeThreads(pr, author, reviewers) {
  const n = Math.floor(rand() * 5);
  const threads = [];
  for (let i = 0; i < n; i++) {
    const who = pick(reviewers.length ? reviewers : DEVS);
    threads.push({
      threadId: i + 1,
      status: rand() < 0.45 ? 'active' : 'fixed',
      filePath: rand() < 0.7 ? pick(['/src/Program.cs', '/src/services/Pricing.cs', '/src/api/orders.ts', '/README.md', '/tests/checkout.spec.ts']) : null,
      author: who,
      content: pick(['Can we add a test for the empty case?', 'Nit: naming.', 'This will N+1 on large carts — batch it?', 'Should this be behind a feature flag?', 'LGTM after the null check.', 'Why not reuse the existing helper in shared-libs?']),
      publishedAt: iso(Date.parse(pr.createdAt) + between(0.5, 30) * H),
    });
    if (rand() < 0.5) threads.push({ threadId: i + 1, status: threads.at(-1).status, filePath: threads.at(-1).filePath, author, content: 'Good catch, updated.', publishedAt: iso(Date.parse(threads.at(-1).publishedAt) + 2 * H) });
  }
  return threads;
}

function addPR(p, repo, { title, author, ageH, status = 'active', closedAgeH, isDraft = false, mergeStatus = 'succeeded', reviewers, autoComplete = false, target }) {
  const id = nextPr++;
  const createdAt = ago(ageH * H);
  const pr = {
    key: `${p.id}/${repo.id}/${id}`,
    id,
    title,
    projectId: p.id,
    projectName: p.name,
    repoId: repo.id,
    repoName: repo.name,
    author,
    createdAt,
    closedAt: closedAgeH != null ? ago(closedAgeH * H) : null,
    status,
    isDraft,
    mergeStatus,
    sourceBranch: BRANCH(title),
    targetBranch: target || repo.defaultBranch,
    reviewers,
    labels: rand() < 0.2 ? [pick(['hotfix', 'breaking-change', 'needs-qa'])] : [],
    autoComplete,
    webUrl: `${ORG}/${p.name}/_git/${repo.name}/pullrequest/${id}`,
  };
  const candidates = [...workItems.values()].filter((w) => w.projectName === p.name && w.type !== 'Task');
  pr._workItemIds = rand() < 0.8 ? sample(candidates, 1 + Math.floor(rand() * 2)).map((w) => w.id) : [];
  pr._workItemIds.forEach((wid) => workItems.get(wid)._prs.push({ projectId: p.id, repoId: repo.id, id }));
  pr._threads = makeThreads(pr, author, reviewers.filter((r) => !r.isContainer));
  pr._buildOk = rand() < 0.8;
  const pool = ['src/api/Controllers/OrdersController.cs', 'src/api/Services/PricingService.cs', 'src/api/Startup.cs', 'src/web/components/Cart.tsx',
    'src/web/components/CheckoutForm.tsx', 'src/web/styles/checkout.css', 'tests/Pricing.Tests/PricingServiceTests.cs', 'README.md', 'azure-pipelines.yml',
    'src/shared/Money.cs', 'docs/adr/0007-pricing-module.md', 'src/web/hooks/useCart.ts'];
  pr._files = sample(pool, 2 + Math.floor(rand() * 7)).map((path, i) => ({
    path: `/${path}`,
    kind: i === 0 && rand() < 0.4 ? 'added' : i === 1 && rand() < 0.15 ? 'deleted' : i === 2 && rand() < 0.15 ? 'renamed' : 'edited',
    originalPath: null,
  })).map((f) => (f.kind === 'renamed' ? { ...f, originalPath: f.path.replace(/(\.\w+)$/, '.old$1') } : f)).sort((a, b) => a.path.localeCompare(b.path));
  prs.set(pr.key, pr);
  return pr;
}

const rv = (who, vote = 0, isRequired = false) => ({ ...who, vote, isRequired, hasDeclined: false });

function activeReviewers(p, author, ageH) {
  const people = sample(PEOPLE.filter((x) => x.id !== author.id), 1 + Math.floor(rand() * 3));
  const list = people.map((x) => {
    const r = rand();
    const vote = ageH < 4 ? 0 : r < 0.45 ? 0 : r < 0.75 ? 10 : r < 0.85 ? 5 : r < 0.95 ? -5 : -10;
    return rv(x, vote);
  });
  if (rand() < 0.6) list.push(rv(p.group, rand() < 0.3 ? 10 : 0, true));
  return list;
}

// Active PRs: random mix plus hand-placed cases so every lead signal shows up.
for (let i = 0; i < 26; i++) {
  const p = pick(PROJECTS);
  const repo = pick(p.repoObjs);
  const author = rand() < 0.12 ? ME : pick(DEVS);
  const ageH = Math.pow(rand(), 3) * 14 * 24 + 0.5;
  addPR(p, repo, {
    title: PR_TITLES[i % PR_TITLES.length], author, ageH,
    isDraft: rand() < 0.1, mergeStatus: rand() < 0.1 ? 'conflicts' : 'succeeded',
    reviewers: activeReviewers(p, author, ageH),
  });
}
{
  const [c, pl, m] = PROJECTS;
  addPR(c, c.repoObjs[1], { title: 'Hotfix: currency rounding for JPY totals', author: DEVS[0], ageH: 14, reviewers: [rv(ME), rv(DEVS[2]), rv(c.group, 0, true)], target: 'main' });
  addPR(pl, pl.repoObjs[0], { title: 'Identity: rotate signing keys automatically', author: DEVS[3], ageH: 30, reviewers: [rv(ME), rv(DEVS[5], 10)] });
  addPR(m, m.repoObjs[0], { title: 'Mobile: migrate to new navigation stack', author: DEVS[4], ageH: 52, reviewers: [] });
  addPR(pl, pl.repoObjs[1], { title: 'Gateway: drop deprecated /v1 routes', author: DEVS[1], ageH: 70, reviewers: [rv(DEVS[2], -10), rv(ME, 0)] });
  addPR(c, c.repoObjs[0], { title: 'Storefront: lazy-load product carousel', author: DEVS[5], ageH: 40, reviewers: [rv(DEVS[0], 10), rv(ME, 10), rv(c.group, 10, true)] });
  addPR(c, c.repoObjs[2], { title: 'Payments: PCI log scrubbing', author: DEVS[6], ageH: 24 * 13, mergeStatus: 'conflicts', reviewers: [rv(DEVS[1], -5), rv(ME, 5)] });
  addPR(pl, pl.repoObjs[2], { title: 'Terraform: private endpoints for SQL', author: ME, ageH: 20, reviewers: [rv(DEVS[3], 0), rv(DEVS[6], 10)] });
}

// Completed/abandoned PRs over the last ~90 days for insights and release notes.
for (let i = 0; i < 140; i++) {
  const p = pick(PROJECTS);
  const repo = pick(p.repoObjs);
  const author = rand() < 0.1 ? ME : pick(DEVS);
  const closedAgeH = between(2, 90 * 24);
  const cycleH = Math.pow(rand(), 1.8) * 140 + 1;
  const reviewers = sample(PEOPLE.filter((x) => x.id !== author.id), 1 + Math.floor(rand() * 2)).map((x) => rv(x, rand() < 0.8 ? 10 : 5));
  addPR(p, repo, {
    title: PR_TITLES[(i * 7) % PR_TITLES.length], author, ageH: closedAgeH + cycleH, closedAgeH,
    status: rand() < 0.06 ? 'abandoned' : 'completed', reviewers,
  });
}

// --------------------------------------------------------------------- builds
const builds = [];
let nextBuild = 20500;
const definitions = ALL_REPOS.flatMap((r, i) => [
  { id: 100 + i * 2, name: `${r.name}-CI`, path: '\\', repo: r, failRate: { 'checkout-api': 0.35, 'mobile-app': 0.3, 'identity-service': 0.2 }[r.name] ?? 0.06 },
  ...(i % 3 === 0 ? [{ id: 101 + i * 2, name: `${r.name}-nightly`, path: '\\nightly', repo: r, failRate: 0.15, nightly: true }] : []),
]);
for (const def of definitions) {
  const p = projectById(def.repo.projectId);
  const runs = def.nightly ? 14 : 30;
  for (let i = 0; i < runs; i++) {
    // Force a red latest default-branch run for the "known broken" pipelines.
    const forcedFail = i === 0 && ['checkout-api-CI', 'mobile-app-CI'].includes(def.name);
    const finished = forcedFail ? NOW - 20 * 60_000 : def.nightly ? NOW - (i * D + 3 * H) : NOW - between(0.5, 14 * 24) * H;
    const r = rand();
    const result = forcedFail || r < def.failRate ? 'failed' : r < def.failRate + 0.04 ? 'partiallySucceeded' : r < def.failRate + 0.06 ? 'canceled' : 'succeeded';
    const prBuild = !def.nightly && !forcedFail && rand() < 0.4;
    builds.push({
      id: nextBuild++,
      projectId: p.id,
      projectName: p.name,
      definition: { id: def.id, name: def.name, path: def.path },
      buildNumber: `${new Date(finished).toISOString().slice(0, 10).replace(/-/g, '')}.${i + 1}`,
      status: 'completed',
      result,
      reason: def.nightly ? 'schedule' : prBuild ? 'pullRequest' : 'individualCI',
      sourceBranch: prBuild ? `refs/pull/${800 + i}/merge` : def.repo.defaultBranch,
      repoId: def.repo.id,
      repoName: def.repo.name,
      requestedFor: def.nightly ? person('svc', 'Scheduler', '') : pick(DEVS),
      queuedAt: iso(finished - 9 * 60_000),
      startedAt: iso(finished - 8 * 60_000),
      finishedAt: iso(finished),
      webUrl: `${ORG}/${p.name}/_build/results?buildId=${nextBuild - 1}`,
    });
  }
}
{
  const def = definitions.find((d) => d.name === 'storefront-web-CI');
  const p = projectById(def.repo.projectId);
  builds.push({
    id: nextBuild++, projectId: p.id, projectName: p.name, definition: { id: def.id, name: def.name, path: def.path },
    buildNumber: 'running.1', status: 'inProgress', result: null, reason: 'individualCI', sourceBranch: 'main', repoId: def.repo.id,
    repoName: def.repo.name, requestedFor: DEVS[2], queuedAt: ago(6 * 60_000), startedAt: ago(5 * 60_000), finishedAt: null,
    webUrl: `${ORG}/${p.name}/_build/results?buildId=${nextBuild - 1}`,
  });
}

// --------------------------------------------------- classic releases + approvals
let nextRelease = 300;
let nextEnv = 9000;
const relWebUrl = (p, id) => `${ORG}/${p.name}/_releaseProgress?releaseId=${id}&_a=release-pipeline-progress`;
const RELEASE_DEFS = [
  { id: 1, project: PROJECTS[0], name: 'Storefront release', path: '\\Web', artifact: 'storefront-web-CI', stages: ['QA', 'Staging', 'Production'] },
  { id: 2, project: PROJECTS[1], name: 'Identity service release', path: '\\Services', artifact: 'identity-service-CI', stages: ['Dev', 'QA', 'Production'] },
  { id: 3, project: PROJECTS[0], name: 'Checkout API release', path: '\\Services', artifact: 'checkout-api-CI', stages: ['QA', 'Production'] },
].map((d) => ({ ...d, stageDefs: d.stages.map((name, i) => ({ id: d.id * 10 + i, name, rank: i + 1 })), releases: [] }));

function addRelease(def, { daysAgo, statuses, by = pick(DEVS) }) {
  const id = nextRelease++;
  const created = NOW - daysAgo * D;
  const r = {
    id, name: `Release-${id - 250}`, createdOn: iso(created), createdBy: by, webUrl: relWebUrl(def.project, id),
    envs: def.stageDefs.map((sd, i) => ({
      id: nextEnv++, definitionEnvironmentId: sd.id, name: sd.name, status: statuses[i] || 'notStarted',
      at: iso(created + (i + 1) * 2 * H), requestedFor: i === 0 ? null : by, reason: i === 0 ? 'automated' : 'manual',
    })),
  };
  def.releases.unshift(r);
  return r;
}
{
  const [store, identity, checkout] = RELEASE_DEFS;
  for (let i = 9; i >= 2; i--) addRelease(store, { daysAgo: i * 2, statuses: ['succeeded', 'succeeded', 'succeeded'] });
  addRelease(store, { daysAgo: 1, statuses: ['succeeded', 'succeeded', 'inProgress'] }); // waiting on a Production approval
  for (let i = 6; i >= 1; i--) addRelease(identity, { daysAgo: i * 3, statuses: ['succeeded', 'succeeded', 'succeeded'] });
  // Reaches Production ~4h ago (stage 3 at created + 6h): the demo error spike starts then.
  addRelease(identity, { daysAgo: 10 / 24, statuses: ['succeeded', 'succeeded', 'succeeded'] });
  // The latest Checkout release failed in QA.
  for (let i = 5; i >= 1; i--) addRelease(checkout, { daysAgo: i * 2.5, statuses: [i === 1 ? 'rejected' : 'succeeded', i <= 2 ? 'notStarted' : 'succeeded'] });
}
const releaseApprovals = [];
{
  const store = RELEASE_DEFS[0];
  const r = store.releases[0];
  releaseApprovals.push({
    kind: 'release', id: 5001, projectId: store.project.id, projectName: store.project.name, pipeline: store.name, stage: 'Production',
    run: { name: r.name, webUrl: r.webUrl }, createdOn: ago(5 * H), instructions: 'Check the Staging smoke tests first.', minRequired: 1,
    approvers: [ME], canDecide: null, _release: r, _env: r.envs[2],
  });
}
// A YAML environment check waiting on the running storefront build.
const pipelineApprovals = [{
  kind: 'yaml', id: 'a1b2c3d4-0000-4000-8000-000000000001', projectId: PROJECTS[0].id, projectName: PROJECTS[0].name,
  pipeline: 'storefront-web-CI', stage: 'Deploy to Production', run: null, createdOn: ago(25 * 60_000),
  instructions: 'Please validate the release before continuing', minRequired: 1, approvers: [], canDecide: true,
}];

function finishLater(env, status = 'succeeded', ms = 15_000) {
  setTimeout(() => Object.assign(env, { status, at: iso(Date.now()) }), ms).unref?.();
}

// ------------------------------------------------------------------ run details
const PLAN = [
  ['Build', 'Build', [['Checkout', 8], ['Restore packages', 35], ['Build solution', 140], ['Publish artifact', 12]]],
  ['Test', 'Unit tests', [['Run tests', 190], ['Publish test results', 9]]],
  ['Deploy to QA', 'Deploy', [['Download artifact', 10], ['Deploy web app', 75], ['Smoke test', 30]]],
];

function demoTimeline(b) {
  const records = [];
  const start = Date.parse(b.startedAt || b.queuedAt);
  const now = b.status === 'completed' ? Date.parse(b.finishedAt) : Date.now();
  const failAt = b.result === 'failed' ? 'Run tests' : b.result === 'canceled' ? 'Run tests' : null;
  let t = start;
  let stopped = false;
  let logId = 1;
  PLAN.forEach(([stageName, jobName, tasks], si) => {
    const stage = { id: `${b.id}-s${si}`, parentId: null, type: 'Stage', name: stageName, order: si + 1, errorCount: 0, warningCount: 0, issues: [], logId: null };
    const job = { id: `${b.id}-j${si}`, parentId: stage.id, type: 'Job', name: jobName, order: 1, errorCount: 0, warningCount: 0, issues: [], logId: logId++ };
    const stageStart = t;
    const taskRecs = tasks.map(([name, secs], ti) => {
      const rec = { id: `${b.id}-t${si}-${ti}`, parentId: job.id, type: 'Task', name, order: ti + 1, errorCount: 0, warningCount: 0, issues: [], logId: logId++ };
      if (b.status === 'notStarted' || stopped) {
        // After a failure Azure DevOps marks the rest completed + skipped; before the run starts they're pending.
        const skipped = stopped && b.status === 'completed';
        Object.assign(rec, { state: skipped ? 'completed' : 'pending', result: skipped ? 'skipped' : null, startedAt: null, finishedAt: null });
        return rec;
      }
      const end = t + secs * 1000;
      if (end > now && b.status !== 'completed') {
        Object.assign(rec, { state: 'inProgress', result: null, startedAt: iso(t), finishedAt: null });
        stopped = true;
        t = end;
        return rec;
      }
      let result = 'succeeded';
      if (name === failAt) {
        result = b.result === 'canceled' ? 'canceled' : 'failed';
        if (result === 'failed') {
          rec.errorCount = 2;
          rec.issues = [
            { type: 'error', message: '3 tests failed: CheckoutTests.Refund_PartialShipment_ReturnsRemainder, CheckoutTests.Refund_Currency_RoundsHalfEven, OrderTests.Cancel_AfterDispatch_IsRejected' },
            { type: 'error', message: 'Process completed with exit code 1.' },
          ];
        }
        stopped = true;
      } else if (b.result === 'partiallySucceeded' && name === 'Build solution') {
        result = 'succeededWithIssues';
        rec.warningCount = 2;
        rec.issues = [{ type: 'warning', message: "CS0618: 'PaymentClient.Charge(decimal)' is obsolete: 'Use ChargeAsync'." }, { type: 'warning', message: 'NU1603: Polly 8.4.0 was not found. Polly 8.4.1 was resolved instead.' }];
      }
      Object.assign(rec, { state: 'completed', result, startedAt: iso(t), finishedAt: iso(end) });
      t = end;
      return rec;
    });
    const states = taskRecs.map((r) => r.state);
    const results = taskRecs.map((r) => r.result);
    const state = states.every((x) => x === 'pending') ? 'pending' : states.every((x) => x === 'completed' || (x === 'pending' && b.status === 'completed')) ? 'completed' : 'inProgress';
    const result = state !== 'completed' ? null
      : results.includes('failed') ? 'failed' : results.includes('canceled') ? 'canceled'
        : results.every((r) => r === 'skipped') ? 'skipped' : results.includes('succeededWithIssues') ? 'succeededWithIssues' : 'succeeded';
    const started = taskRecs.find((r) => r.startedAt)?.startedAt || null;
    const finished = state === 'completed' ? [...taskRecs].reverse().find((r) => r.finishedAt)?.finishedAt || null : null;
    for (const rec of [stage, job]) {
      Object.assign(rec, { state, result, startedAt: started, finishedAt: finished });
      rec.errorCount = taskRecs.reduce((n, r) => n + r.errorCount, 0);
      rec.warningCount = taskRecs.reduce((n, r) => n + r.warningCount, 0);
    }
    if (stageStart === t && state === 'pending') Object.assign(stage, { startedAt: null });
    records.push(stage, job, ...taskRecs);
  });
  return records;
}

function demoLog(b, logId) {
  const rec = demoTimeline(b).find((r) => r.logId === logId);
  const lines = [
    `##[section]Starting: ${rec?.name || 'step'}`,
    'Task         : Command line',
    `Agent        : Hosted Agent (ubuntu-latest)`,
    '  Determining projects to restore...',
    '  All projects are up-to-date for restore.',
  ];
  if (rec?.result === 'failed') {
    lines.push(
      '  Passed!  - Failed:     0, Passed:   188, Skipped:     2, Total:   190 - Catalog.Tests.dll',
      '  Failed CheckoutTests.Refund_PartialShipment_ReturnsRemainder [41 ms]',
      '  Error Message:',
      '   Expected refund.Amount to be 12.50M, but found 25.00M.',
      '  Stack Trace:',
      '     at Checkout.Tests.CheckoutTests.Refund_PartialShipment_ReturnsRemainder() in /src/Checkout.Tests/CheckoutTests.cs:line 214',
      '  Failed CheckoutTests.Refund_Currency_RoundsHalfEven [12 ms]',
      '  Error Message:',
      '   Expected 10.13M, but found 10.12M.',
      '  Failed OrderTests.Cancel_AfterDispatch_IsRejected [8 ms]',
      '  Error Message:',
      '   Expected status 409 (Conflict), but found 200 (OK).',
      'Failed!  - Failed:     3, Passed:   219, Skipped:     0, Total:   222 - Checkout.Tests.dll',
      '##[error]Process completed with exit code 1.',
      `##[section]Finishing: ${rec.name}`,
    );
  } else {
    lines.push('  Done.', `##[section]Finishing: ${rec?.name || 'step'}`);
  }
  return lines.join('\n');
}

const COMMITS = ['Fix rounding in partial refunds', 'Add retry to payment webhook', 'Bump Polly to 8.4.1', 'Refactor order cancellation rules', 'Log correlation ids on checkout'];

// Commit history: a few commits a day per repo and branch for 60 days, the
// same on every start. Completed PRs show up as their merge commits, and some
// messages mention work items (AB#123), as Azure DevOps teams tend to write them.
const COMMIT_MESSAGES = [
  ...COMMITS, 'Add integration tests for order export', 'Tidy up logging', 'Update README with local setup', 'Handle null customer on guest orders',
  'Extract pricing rules into their own module', 'Bump Node to 22 in the pipeline', 'Fix flaky date test around midnight', 'Rename OrderDto fields to match the API',
  'Remove unused feature flag', 'Speed up catalog query with an index', 'Retry transient SQL errors', 'Add health check endpoint',
];
const COMMIT_FILES = ['src/api/Controllers/OrdersController.cs', 'src/api/Services/PricingService.cs', 'src/web/components/Cart.tsx', 'src/web/hooks/useCart.ts',
  'tests/Pricing.Tests/PricingServiceTests.cs', 'README.md', 'azure-pipelines.yml', 'src/shared/Money.cs', 'src/api/appsettings.json', 'docs/adr/0008-retries.md'];
const commitLists = new Map(); // `${repoId}|${branch}` -> commits, newest first
const commitsById = new Map();
const hex = (r, n) => Array.from({ length: n }, () => Math.floor(r() * 16).toString(16)).join('');

function demoCommits(repo, branch = repo.defaultBranch) {
  const key = `${repo.id}|${branch}`;
  if (commitLists.has(key)) return commitLists.get(key);
  const local = rng([...key].reduce((s, c) => (s * 31 + c.charCodeAt(0)) | 0, 7));
  const items = [...workItems.values()].filter((w) => w.projectName === repo.projectName && w.type !== 'Task');
  const merged = branch === repo.defaultBranch ? [...prs.values()].filter((p) => p.repoId === repo.id && p.status === 'completed' && p.closedAt) : [];
  const list = [];
  for (let t = NOW - (0.5 + local() * 6) * H; t > NOW - 60 * D; t -= (2 + local() * 14) * H) {
    const who = DEVS[Math.floor(local() * DEVS.length)];
    let message = COMMIT_MESSAGES[Math.floor(local() * COMMIT_MESSAGES.length)];
    if (items.length && local() < 0.35) message += ` (AB#${items[Math.floor(local() * items.length)].id})`;
    if (local() < 0.2) message += '\n\nKeeps the old behaviour behind a setting for one release.';
    list.push({ when: t, who, message });
  }
  for (const p of merged) list.push({ when: Date.parse(p.closedAt), who: p.author, message: `Merged PR ${p.id}: ${p.title}\n\nRelated work items: ${p._workItemIds.map((id) => `#${id}`).join(', ')}` });
  const commits = list.sort((a, b) => b.when - a.when).map(({ when, who, message }) => {
    const id = hex(local, 40);
    const files = [...COMMIT_FILES].sort(() => local() - 0.5).slice(0, 1 + Math.floor(local() * 5))
      .map((path, i) => ({ path: `/${path}`, kind: i === 0 && local() < 0.3 ? 'added' : 'edited', originalPath: null }));
    const added = files.filter((f) => f.kind === 'added').length;
    const c = {
      id,
      message,
      truncated: false,
      author: { name: who.displayName, email: who.uniqueName, date: iso(when) },
      committedAt: iso(when),
      changes: { added, edited: files.length - added, deleted: 0 },
      webUrl: `${ORG}/${repo.projectName}/_git/${repo.name}/commit/${id}`,
      _files: files,
    };
    commitsById.set(id, c);
    return c;
  });
  commitLists.set(key, commits);
  return commits;
}
const stripCommit = ({ _files, ...rest }) => ({ ...rest, author: { ...rest.author } });

// Deploy history for a production environment (a release stage or a pipeline):
// the recent releases and builds above, then older, made-up deploys going back
// 60 days, each pointing at the newest demo commit before it started.
const deployHistories = new Map();
function demoDeployHistory(target) {
  const key = `${target.type}:${target.definitionId}:${target.stage || ''}`;
  if (deployHistories.has(key)) return deployHistories.get(key);
  const local = rng([...key].reduce((s, c) => (s * 31 + c.charCodeAt(0)) | 0, 11));
  let list = [];
  let repo = null;
  if (target.type === 'release') {
    const def = RELEASE_DEFS.find((d) => d.id === Number(target.definitionId));
    repo = definitions.find((x) => x.name === def?.artifact)?.repo || null;
    for (const r of def?.releases || []) {
      const e = r.envs.find((x) => !target.stage || x.name === target.stage);
      if (!e || !['succeeded', 'rejected', 'partiallySucceeded'].includes(e.status)) continue;
      list.push({ id: r.id, label: r.name, at: e.at, status: e.status === 'rejected' ? 'failed' : e.status, by: (e.requestedFor || r.createdBy)?.displayName || null, webUrl: r.webUrl });
    }
    let n = Math.min(...list.map((d) => Number(d.label.split('-')[1])).filter(Number.isFinite), 50);
    let t = Math.min(...list.map((d) => Date.parse(d.at)), NOW) - (1 + local() * 3) * D;
    while (t > NOW - 60 * D) {
      n -= 1;
      const id = 299 - (60 - n);
      list.push({ id, label: `Release-${n}`, at: iso(t), status: local() < 0.12 ? 'failed' : 'succeeded', by: DEVS[Math.floor(local() * DEVS.length)].displayName, webUrl: relWebUrl(def.project, id) });
      t -= (1 + local() * 4) * D;
    }
  } else {
    const def = definitions.find((d) => d.id === Number(target.definitionId));
    repo = def?.repo || null;
    const runs = builds.filter((b) => b.definition.id === Number(target.definitionId) && b.status === 'completed' && b.reason !== 'pullRequest' && b.result !== 'canceled');
    list = runs.map((b) => ({ id: b.id, label: b.buildNumber, at: b.finishedAt, status: b.result, by: b.requestedFor?.displayName || null, webUrl: b.webUrl }));
    let t = Math.min(...list.map((d) => Date.parse(d.at)), NOW) - (0.5 + local() * 2) * D;
    let id = 19000 + Number(target.definitionId) * 100;
    while (t > NOW - 60 * D && repo) {
      const p = projectById(repo.projectId);
      list.push({ id, label: new Date(t).toISOString().slice(0, 10).replace(/-/g, ''), at: iso(t), status: local() < 0.15 ? 'failed' : 'succeeded', by: DEVS[Math.floor(local() * DEVS.length)].displayName, webUrl: `${ORG}/${p.name}/_build/results?buildId=${id}` });
      id += 1;
      t -= (0.5 + local() * 2) * D;
    }
  }
  const commits = repo ? demoCommits(repo) : [];
  const history = list
    .map((d) => ({ ...d, startedAt: iso(Date.parse(d.at) - 12 * 60_000), repoId: repo?.id || null, commit: commits.find((c) => Date.parse(c.author.date) < Date.parse(d.at) - 30 * 60_000)?.id || null }))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  deployHistories.set(key, history);
  return history;
}

// ------------------------------------------------------------------ provider
const strip = ({ _description, _acceptance, _comments, _prs, _board, _attachments, ...rest }) => ({ ...rest });
const stripPR = ({ _workItemIds, _threads, _buildOk, _files, _description, ...rest }) => ({ ...rest, reviewers: rest.reviewers.map((r) => ({ ...r })) });
const delay = (v) => new Promise((r) => setTimeout(() => r(v), 40 + Math.random() * 120));
const notFound = (what) => Object.assign(new Error(`${what} not found`), { status: 404 });

function getPR(projectId, repoId, prId) {
  const pr = prs.get(`${projectById(projectId)?.id}/${repoId}/${prId}`);
  if (!pr) throw notFound(`Pull request ${prId}`);
  return pr;
}

/**
 * Keeps the demo org alive: every 45s a teammate votes on your PR, a new
 * review request arrives, a pipeline breaks or a deployment needs approval,
 * so live updates and notifications can be tried without a real org.
 */
let demoActivityStarted = false;
function startDemoActivity() {
  if (demoActivityStarted) return;
  demoActivityStarted = true;
  let step = 0;
  const events = [
    () => {
      const pr = [...prs.values()].find((p) => p.status === 'active' && p.author.id === ME.id && p.reviewers.some((r) => !r.isContainer && r.vote === 0));
      const r = pr?.reviewers.find((x) => !x.isContainer && x.vote === 0);
      if (r) r.vote = 10;
    },
    () => {
      const p = pick(PROJECTS);
      const author = pick(DEVS);
      const pr = addPR(p, pick(p.repoObjs), {
        title: pick(['Add health checks to the gateway', 'Fix N+1 query in order history', 'Bump Node to 22 LTS', 'Retry flaky payment webhook']),
        author, ageH: 0, reviewers: [rv(ME), rv(pick(DEVS.filter((d) => d.id !== author.id)))],
      });
      pr.createdAt = iso(Date.now());
    },
    () => {
      const def = definitions.find((d) => !d.nightly && !builds.some((b) => b.definition.id === d.id && b.status === 'completed' && b.result === 'failed' && Date.now() - Date.parse(b.finishedAt) < H));
      if (!def) return;
      const p = projectById(def.repo.projectId);
      builds.unshift({
        id: nextBuild++, projectId: p.id, projectName: p.name, definition: { id: def.id, name: def.name, path: def.path },
        buildNumber: `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.live`, status: 'completed', result: 'failed', reason: 'individualCI',
        sourceBranch: def.repo.defaultBranch, repoId: def.repo.id, repoName: def.repo.name, requestedFor: pick(DEVS),
        queuedAt: iso(Date.now() - 8 * 60_000), startedAt: iso(Date.now() - 7 * 60_000), finishedAt: iso(Date.now()), webUrl: `${ORG}/${p.name}/_build/results?buildId=${nextBuild - 1}`,
      });
    },
    () => {
      if (pipelineApprovals.length) return;
      pipelineApprovals.push({
        kind: 'yaml', id: `a1b2c3d4-0000-4000-8000-${String(Date.now()).slice(-12)}`, projectId: PROJECTS[0].id, projectName: PROJECTS[0].name,
        pipeline: 'storefront-web-CI', stage: 'Deploy to Production', run: null, createdOn: iso(Date.now()),
        instructions: 'Please validate the release before continuing', minRequired: 1, approvers: [], canDecide: true,
      });
    },
  ];
  const t = setInterval(() => events[step++ % events.length](), 45_000);
  t.unref?.();
}

export function createMockProvider() {
  startDemoActivity();
  return {
    kind: 'mock',
    orgUrl: ORG,
    fetchOrgImage: () => Promise.reject(Object.assign(new Error('No images in demo mode'), { status: 404 })),
    me: () => delay({ ...ME }),
    listProjects: () => delay(PROJECTS.map((p) => ({ id: p.id, name: p.name, description: `${p.name} product area`, webUrl: `${ORG}/${p.name}` }))),
    listTeams: (projectId) => delay([projectById(projectId).team]),
    listTeamMembers: (projectId) => delay(projectId === 'p-mobile' ? [ME, ...DEVS.slice(3)] : PEOPLE.slice(0, 6)),
    getTeamAreas: (projectId) => delay([{ value: projectById(projectId).name, includeChildren: true }]),
    getCurrentIteration: (projectId) => delay(SPRINTS(projectById(projectId)).current),
    getTeamDefaultArea: (projectId) => delay(projectById(projectId).name),
    listRepos: (projectId) => delay(projectById(projectId).repoObjs.map((r) => ({ ...r }))),

    listPullRequests: (projectId, { status = 'active', closedAfter } = {}) => delay(
      [...prs.values()]
        .filter((pr) => pr.projectId === projectById(projectId).id)
        .filter((pr) => (status === 'completed' ? pr.status === 'completed' : status === 'all' ? true : pr.status === status))
        .filter((pr) => !closedAfter || (pr.closedAt && Date.parse(pr.closedAt) >= Date.parse(closedAfter)))
        .map(stripPR),
    ),

    async getPullRequest(projectId, repoId, prId) {
      const pr = getPR(projectId, repoId, prId);
      const approvals = pr.reviewers.filter((r) => r.vote >= 5 && !r.isContainer).length;
      const linked = pr._workItemIds.map((id) => workItems.get(id)).filter(Boolean);
      return delay({
        ...stripPR(pr),
        description: pr._description ?? `## Summary\n${pr.title}.\n\n## Changes\n- Moved logic into \`PricingService\`\n- **Breaking:** removed the v1 endpoint\n\n| Area | Risk |\n|---|---|\n| API | Low |\n| Web | Medium |\n\n## Testing\n- [x] Unit tests added\n- [ ] Verified on QA\n\nCC @<${DEVS[0].id}>`,
        autoCompleteSetBy: pr.autoComplete ? pr.author : null,
        completionOptions: null,
        threads: {
          total: new Set(pr._threads.map((t) => t.threadId)).size,
          active: new Set(pr._threads.filter((t) => t.status === 'active').map((t) => t.threadId)).size,
          recent: [...pr._threads].sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)).slice(0, 15),
        },
        workItems: linked.map(({ id, title, type, state, stateCategory, webUrl }) => ({ id, title, type, state, stateCategory, webUrl })),
        files: { iteration: 1, total: pr._files.length, truncated: false, items: pr._files.map((f) => ({ ...f })) },
        policies: [
          { name: 'Minimum number of reviewers (2)', status: approvals >= 2 ? 'approved' : 'queued', isBlocking: true },
          { name: `Build: ${pr.repoName}-CI`, status: pr.isDraft ? 'queued' : pr._buildOk ? 'approved' : 'rejected', isBlocking: true },
          { name: 'Work items linked', status: linked.length ? 'approved' : 'rejected', isBlocking: false },
          { name: 'Comments resolved', status: pr._threads.some((t) => t.status === 'active') ? 'rejected' : 'approved', isBlocking: true },
        ],
      });
    },

    getPullRequestWorkItemIds: (projectId, repoId, prId) => delay([...getPR(projectId, repoId, prId)._workItemIds]),

    listReleases(projectId) {
      const p = projectById(projectId);
      return delay(RELEASE_DEFS.filter((d) => d.project.id === p.id).map((d) => ({
        id: d.id, name: d.name, path: d.path, projectId: p.id, projectName: p.name,
        webUrl: `${ORG}/${p.name}/_release?definitionId=${d.id}&view=mine&_a=releases`,
        artifacts: [{ type: 'Build', alias: `_${d.artifact}`, sourceId: definitions.find((x) => x.name === d.artifact)?.id ?? null, sourceName: d.artifact, isPrimary: true }],
        stages: stageSummary(d.stageDefs, d.releases),
        releases: d.releases.slice(0, 10).map((r) => ({
          id: r.id, name: r.name, createdOn: r.createdOn, createdBy: r.createdBy, webUrl: r.webUrl,
          stages: r.envs.map((e) => ({ id: e.id, definitionEnvironmentId: e.definitionEnvironmentId, name: e.name, status: e.status, at: e.at, requestedFor: e.requestedFor, deploying: e.status === 'inProgress' && !!e.deploying, startedAt: e.at })),
        })),
      })));
    },

    listReleaseApprovals: (projectId) => delay(releaseApprovals
      .filter((a) => a.projectId === projectById(projectId).id)
      .map(({ _release, _env, ...a }) => ({ ...a }))),

    listPipelineApprovals(projectId, projectName, runningBuilds = []) {
      const run = runningBuilds.find((b) => b.definition.name === 'storefront-web-CI');
      return delay(pipelineApprovals
        .filter((a) => a.projectId === projectById(projectId).id)
        .map((a) => ({ ...a, run: run ? { id: run.id, name: run.buildNumber, webUrl: run.webUrl, branch: run.sourceBranch } : a.run })));
    },

    async decideReleaseApproval(projectName, approvalId, status) {
      const i = releaseApprovals.findIndex((a) => a.id === Number(approvalId));
      if (i < 0) throw notFound('Approval');
      const [a] = releaseApprovals.splice(i, 1);
      if (status === 'approved') finishLater(a._env, 'succeeded', 10_000);
      else Object.assign(a._env, { status: 'rejected', at: iso(Date.now()) });
      return delay();
    },

    async decidePipelineApproval(projectName, approvalId) {
      const i = pipelineApprovals.findIndex((a) => a.id === approvalId);
      if (i < 0) throw notFound('Approval');
      pipelineApprovals.splice(i, 1);
      return delay();
    },

    async createRelease(projectName, definitionId) {
      const def = RELEASE_DEFS.find((d) => d.id === Number(definitionId));
      if (!def) throw notFound('Release pipeline');
      const r = addRelease(def, { daysAgo: 0, statuses: ['inProgress'], by: ME });
      r.envs[0].deploying = true;
      finishLater(r.envs[0]);
      return delay({ id: r.id, name: r.name, webUrl: r.webUrl });
    },

    async deployReleaseStage(projectName, releaseId, environmentId) {
      const r = RELEASE_DEFS.flatMap((d) => d.releases).find((x) => x.id === Number(releaseId));
      const env = r?.envs.find((e) => e.id === Number(environmentId));
      if (!env) throw notFound('Release stage');
      Object.assign(env, { status: 'inProgress', deploying: true, at: iso(Date.now()), requestedFor: ME, reason: 'manual' });
      finishLater(env);
      return delay();
    },

    listBranches(projectId, repoId) {
      const repo = ALL_REPOS.find((r) => r.id === repoId);
      if (!repo) throw notFound('Repository');
      const fromPrs = [...prs.values()].filter((p) => p.repoId === repoId).map((p) => p.sourceBranch);
      const extra = ['feature/4107-invoice-pdf', 'bugfix/coupon-double-apply', 'chore/upgrade-node-22', 'release/2026.10'];
      const names = [...new Set([repo.defaultBranch, 'develop', ...extra, ...fromPrs])];
      return delay(names.map((name, i) => ({
        name,
        pushedAt: i < 8 ? ago((i + 1) * 5 * H) : null,
        pushedBy: i < 8 ? pick(DEVS) : null,
      })));
    },

    listCommits(projectId, repoId, { branch, since, top = 300 } = {}) {
      const repo = ALL_REPOS.find((r) => r.id === repoId);
      if (!repo) throw notFound('Repository');
      const from = since ? Date.parse(since) : 0;
      return delay(demoCommits(repo, branch || repo.defaultBranch).filter((c) => Date.parse(c.author.date) >= from).slice(0, top).map(stripCommit));
    },

    listCommitsBetween(projectId, repoId, from, to, { top = 300 } = {}) {
      const repo = ALL_REPOS.find((r) => r.id === repoId);
      if (!repo) throw notFound('Repository');
      const list = demoCommits(repo);
      const end = list.findIndex((c) => c.id === to);
      if (end < 0) throw notFound(`Commit ${to}`);
      const start = list.findIndex((c) => c.id === from);
      return delay(list.slice(end, start < 0 ? undefined : start).slice(0, top).map(stripCommit));
    },

    listDeployments(target, { since }) {
      const from = since ? Date.parse(since) : 0;
      return delay(demoDeployHistory(target).filter((d) => Date.parse(d.at) >= from).map((d) => ({ ...d })));
    },

    getCommit(projectId, repoId, commitId) {
      const repo = ALL_REPOS.find((r) => r.id === repoId);
      if (!repo) throw notFound('Repository');
      demoCommits(repo);
      const c = commitsById.get(String(commitId).toLowerCase());
      if (!c || !c.webUrl.includes(`/_git/${repo.name}/`)) throw notFound(`Commit ${commitId}`);
      return delay({ ...stripCommit(c), parents: [], files: c._files.map((f) => ({ ...f })) });
    },

    compareBranches(projectId, repoId, source, target) {
      if (source === target) return delay({ ahead: 0, behind: 0, commits: [], files: { total: 0, items: [] }, existing: [], template: null });
      const local = rng([...`${repoId}${source}`].reduce((s, c) => s + c.charCodeAt(0), 0));
      const n = 1 + Math.floor(local() * 4);
      const msgs = ['Add PDF renderer for invoices', 'Wire export endpoint', 'Tests for invoice totals', 'Fix rounding in VAT lines (AB#4107)', 'Address review comments'];
      const pool = ['/src/api/Controllers/InvoicesController.cs', '/src/api/Services/InvoicePdf.cs', '/src/web/pages/Invoices.tsx', '/tests/InvoicePdfTests.cs', '/README.md', '/src/legacy/OldExporter.cs'];
      const existing = [...prs.values()].filter((p) => p.repoId === repoId && p.status === 'active' && p.sourceBranch === source && p.targetBranch === target);
      return delay({
        ahead: n,
        behind: Math.floor(local() * 6),
        commits: msgs.slice(0, n).map((m, i) => ({ id: `c0ffee${i}${n}`, message: m, author: pick(DEVS).displayName, date: ago((i + 1) * 3 * H) })),
        files: { total: 2 + n, items: pool.slice(0, 2 + n).map((path) => ({ path, kind: path.includes('legacy') ? 'deleted' : path.includes('Pdf') ? 'added' : 'edited', originalPath: null })) },
        existing: existing.map(({ id, title, webUrl, projectId: pid, repoId: rid }) => ({ id, title, webUrl, projectId: pid, repoId: rid })),
        template: '## Summary\n\n<!-- What does this change and why? -->\n\n## How was it tested?\n\n- [ ] Unit tests\n- [ ] Manually on QA\n',
      });
    },

    async createPullRequest(projectId, repoId, input) {
      const p = projectById(projectId);
      const repo = p?.repoObjs.find((r) => r.id === repoId);
      if (!repo) throw notFound('Repository');
      const id = nextPr++;
      const pr = {
        key: `${p.id}/${repo.id}/${id}`, id, title: input.title, projectId: p.id, projectName: p.name, repoId: repo.id, repoName: repo.name,
        author: ME, createdAt: iso(Date.now()), closedAt: null, status: 'active', isDraft: !!input.isDraft, mergeStatus: 'succeeded',
        sourceBranch: input.source, targetBranch: input.target,
        reviewers: (input.reviewers || []).map((r) => rv(PEOPLE.find((x) => x.id === r.id) || { id: r.id, displayName: r.id, uniqueName: '' }, 0, !!r.isRequired)),
        labels: [], autoComplete: !!input.autoComplete && !input.isDraft, webUrl: `${ORG}/${p.name}/_git/${repo.name}/pullrequest/${id}`,
        _workItemIds: (input.workItemIds || []).map(Number).filter((wid) => workItems.has(wid)),
        _threads: [], _buildOk: true, _files: [], _description: input.description || '',
      };
      pr._workItemIds.forEach((wid) => workItems.get(wid)._prs.push({ projectId: p.id, repoId: repo.id, id }));
      prs.set(pr.key, pr);
      return delay(stripPR(pr));
    },

    async votePullRequest(projectId, repoId, prId, vote) {
      const pr = getPR(projectId, repoId, prId);
      const mine = pr.reviewers.find((r) => r.id === ME.id);
      if (mine) mine.vote = vote;
      else pr.reviewers.push(rv(ME, vote));
      return delay();
    },

    async addReviewer(projectId, repoId, prId, reviewerId, isRequired = false) {
      const pr = getPR(projectId, repoId, prId);
      const who = PEOPLE.find((x) => x.id === reviewerId);
      if (!who) throw notFound('Reviewer');
      if (!pr.reviewers.some((r) => r.id === reviewerId)) pr.reviewers.push(rv(who, 0, isRequired));
      return delay();
    },

    async commentPullRequest(projectId, repoId, prId, content) {
      const pr = getPR(projectId, repoId, prId);
      pr._threads.push({ threadId: pr._threads.length + 100, status: 'active', filePath: null, author: ME, content, publishedAt: iso(Date.now()) });
      return delay();
    },

    async listPullRequestConflicts(projectId, repoId, prId) {
      const pr = getPR(projectId, repoId, prId);
      if (pr.mergeStatus !== 'conflicts') return delay([]);
      const kinds = ['editEdit', 'editEdit', 'deleteEdit', 'addAdd', 'renameRename'];
      const files = pr._files.length ? pr._files : [{ path: '/src/app.ts' }];
      return delay(files.slice(0, Math.min(3, files.length)).map((f, i) => ({
        id: i + 1, path: f.path, type: kinds[(pr.id + i) % kinds.length], status: 'unresolved',
      })));
    },

    async restartMerge(projectId, repoId, prId) {
      const pr = getPR(projectId, repoId, prId);
      const after = pr.mergeStatus === 'conflicts' ? 'conflicts' : 'succeeded';
      pr.mergeStatus = 'queued';
      setTimeout(() => { pr.mergeStatus = after; }, 4000).unref?.();
      return delay();
    },

    async updatePullRequest(projectId, repoId, prId, change) {
      const pr = getPR(projectId, repoId, prId);
      if (change.publish) pr.isDraft = false;
      if (change.abandon) Object.assign(pr, { status: 'abandoned', closedAt: iso(Date.now()) });
      if (change.autoComplete !== undefined) pr.autoComplete = !!change.autoComplete;
      if (change.complete) {
        if (pr.mergeStatus === 'conflicts') throw Object.assign(new Error('The pull request has merge conflicts. Resolve them before completing.'), { status: 409 });
        const opts = change.completionOptions || {};
        const approvals = pr.reviewers.filter((r) => r.vote >= 5 && !r.isContainer).length;
        if (approvals < 2 && !opts.bypassPolicy) {
          throw Object.assign(new Error('TF401027: The policy "Minimum number of reviewers (2)" is not satisfied. Get approvals, or override policies if you have permission.'), { status: 400 });
        }
        Object.assign(pr, { status: 'completed', closedAt: iso(Date.now()), autoComplete: false });
        if (opts.transitionWorkItems) {
          for (const wid of pr._workItemIds) {
            const w = workItems.get(wid);
            const done = projectById(w.projectName).stateMap[w.type].find((s) => s.category === 'Completed');
            if (done && w.stateCategory !== 'Completed') Object.assign(w, { state: done.name, stateCategory: 'Completed', closedAt: iso(Date.now()) });
          }
        }
      }
      return delay();
    },

    getStateMap: (projectId) => delay(projectById(projectId).stateMap),
    getWorkItemTypes: (projectId) => delay(Object.keys(projectById(projectId).stateMap).map((name) => ({ name, color: TYPE_COLORS[name] || null }))),

    queryWorkItems(projectId, c = {}) {
      const p = projectById(projectId);
      const typeOk = (w) => {
        if (c.types?.length) return c.types.includes(w.type);
        const cats = c.categories || (c.parentId ? null : ['requirement', 'bug', 'task']);
        if (!cats) return true;
        const cat = { Bug: 'bug', Task: 'task', Feature: 'feature', Epic: 'epic' }[w.type] || 'requirement';
        return cats.includes(cat);
      };
      const list = [...workItems.values()].filter((w) => w.projectName === p.name
        && typeOk(w)
        && w.stateCategory !== 'Removed'
        && (!c.open || w.stateCategory !== 'Completed')
        && (!c.iterationPath || w.iterationPath === c.iterationPath || w.iterationPath.startsWith(`${c.iterationPath}\\`))
        && (!c.areaPaths?.length || c.areaPaths.some((a) => w.areaPath === a.value || (a.includeChildren && w.areaPath.startsWith(`${a.value}\\`))))
        && (!c.assignedToMe || w.assignedTo?.id === ME.id)
        && (!c.unassigned || !w.assignedTo)
        && (!c.tag || w.tags.some((t) => t.toLowerCase().includes(c.tag.toLowerCase())))
        && (!c.changedWithinDays || Date.parse(w.changedAt) >= NOW - c.changedWithinDays * D)
        && (!c.parentId || w.parentId === Number(c.parentId))
        && (!c.doneWithinDays || (w.stateCategory === 'Completed' && Date.parse(w.changedAt) >= Date.now() - c.doneWithinDays * D)));
      const withBoard = (w) => (c.extraFields?.length
        ? { ...strip(w), boardFields: { 'Mock_Kanban.Column': w._board?.column ?? null, 'Mock_Kanban.Column.Done': !!w._board?.done, 'Mock_Kanban.Lane': w._board?.lane ?? null } }
        : strip(w));
      return delay(list.sort((a, b) => Date.parse(b.changedAt) - Date.parse(a.changedAt)).slice(0, c.top || 1000).map(withBoard));
    },

    getBoards(projectId) {
      const p = projectById(projectId);
      const scrum = p.process === SCRUM;
      const map = (pairs) => Object.fromEntries(pairs);
      const fields = { column: 'Mock_Kanban.Column', done: 'Mock_Kanban.Column.Done', lane: 'Mock_Kanban.Lane' };
      const lanes = p.name === 'Commerce' ? [{ id: 'l0', name: null }, { id: 'l1', name: 'Expedite' }] : [{ id: 'l0', name: null }];
      const req = scrum
        ? { name: 'Backlog items', types: ['Product Backlog Item', 'Bug'], columns: [
          ['New', 'incoming', { 'Product Backlog Item': 'New', Bug: 'New' }], ['Approved', 'inProgress', { 'Product Backlog Item': 'Approved', Bug: 'Approved' }],
          ['Committed', 'inProgress', { 'Product Backlog Item': 'Committed', Bug: 'Committed' }, true, 4], ['Done', 'outgoing', { 'Product Backlog Item': 'Done', Bug: 'Done' }]] }
        : { name: 'Stories', types: ['User Story', 'Bug'], columns: [
          ['New', 'incoming', { 'User Story': 'New', Bug: 'New' }], ['Ready', 'inProgress', { 'User Story': 'New', Bug: 'New' }, false, 6],
          ['Active', 'inProgress', { 'User Story': 'Active', Bug: 'Active' }, true, 4], ['Review', 'inProgress', { 'User Story': 'Resolved', Bug: 'Resolved' }, false, 3],
          ['Closed', 'outgoing', { 'User Story': 'Closed', Bug: 'Closed' }]] };
      const portfolio = (name, type, states) => ({ name, types: [type], columns: states.map(([n, t, st]) => [n, t, { [type]: st }]) });
      const featureStates = scrum ? [['New', 'incoming', 'New'], ['In Progress', 'inProgress', 'In Progress'], ['Done', 'outgoing', 'Done']] : [['New', 'incoming', 'New'], ['Active', 'inProgress', 'Active'], ['Closed', 'outgoing', 'Closed']];
      const defs = [{ ...req, isRequirement: true, rank: 0 }, { ...portfolio('Features', 'Feature', featureStates), rank: 1 }, { ...portfolio('Epics', 'Epic', featureStates), rank: 2 }];
      return delay({
        boards: defs.map((d, i) => ({
          id: `${p.id}-board-${i}`, name: d.name, level: null, rank: d.rank, isRequirement: !!d.isRequirement, hidden: false, types: d.types,
          columns: d.columns.map(([name, columnType, stateMappings, isSplit = false, itemLimit = 0], j) => ({ id: `c${i}${j}`, name, columnType, isSplit, itemLimit, stateMappings })),
          lanes: d.isRequirement ? lanes : [{ id: 'l0', name: null }], fields,
        })),
        taskTypes: ['Task'],
        workTypes: [...req.types, 'Task'],
      });
    },

    getHierarchy(projectId, { includeClosed = false } = {}) {
      const p = projectById(projectId);
      const all = [...workItems.values()].filter((w) => w.projectName === p.name && w.stateCategory !== 'Removed');
      const roots = all.filter((w) => w.type === 'Epic' && (includeClosed || w.stateCategory !== 'Completed'));
      const items = [];
      const links = [];
      const walk = (w) => {
        items.push(strip(w));
        for (const c of all.filter((x) => x.parentId === w.id)) {
          links.push({ parent: w.id, child: c.id });
          walk(c);
        }
      };
      roots.forEach(walk);
      return delay({ roots: roots.map((r) => r.id), links, items });
    },

    getWorkItems: (ids) => delay(ids.map((id) => workItems.get(Number(id))).filter(Boolean).map(strip)),

    async getWorkItem(id) {
      const w = workItems.get(Number(id));
      if (!w) throw notFound(`Work item ${id}`);
      const pickRel = ({ id: i, title, type, state, stateCategory, assignedTo, webUrl }) => ({ id: i, title, type, state, stateCategory, assignedTo, webUrl });
      return delay({
        ...strip(w),
        description: w._description,
        acceptanceCriteria: w.type === 'Task' ? '' : w._acceptance,
        parent: w.parentId ? pickRel(workItems.get(w.parentId)) : null,
        children: [...workItems.values()].filter((c) => c.parentId === w.id).map(pickRel),
        pullRequests: w._prs.map((x) => ({ ...x })),
        attachments: w._attachments.map(({ by, ...a }) => a),
        comments: [...w._comments].reverse(),
      });
    },

    async reorderWorkItems(projectId, teamId, { ids, previousId = 0, nextId = 0 }) {
      const order = (id) => workItems.get(Number(id))?.backlogOrder;
      const prev = previousId ? order(previousId) : null;
      const next = nextId ? order(nextId) : null;
      const base = prev != null && next != null ? (prev + next) / 2 : prev != null ? prev + 10 : next != null ? next - 10 : 0;
      return delay(ids.map((id, i) => {
        const w = workItems.get(Number(id));
        if (!w) throw notFound(`Work item ${id}`);
        w.backlogOrder = base + i * 0.001;
        return { id: w.id, order: w.backlogOrder };
      }));
    },

    async updateWorkItem(id, changes) {
      const w = workItems.get(Number(id));
      if (!w) throw notFound(`Work item ${id}`);
      const p = projectById(w.projectName);
      if (changes.state !== undefined) {
        const st = p.stateMap[w.type].find((s) => s.name === changes.state);
        if (!st) throw Object.assign(new Error(`State '${changes.state}' is not valid for ${w.type}`), { status: 400 });
        Object.assign(w, { state: st.name, stateCategory: st.category, stateChangedAt: iso(Date.now()), closedAt: st.category === 'Completed' ? iso(Date.now()) : null });
      }
      if (changes.assignedTo !== undefined) {
        w.assignedTo = changes.assignedTo ? PEOPLE.find((x) => x.uniqueName === changes.assignedTo) || null : null;
      }
      if (changes.priority !== undefined) w.priority = Number(changes.priority);
      if (changes.iterationPath !== undefined) w.iterationPath = changes.iterationPath;
      if (changes.tags !== undefined) w.tags = changes.tags;
      if (changes.fields) {
        const b = (w._board ||= {});
        if ('Mock_Kanban.Column' in changes.fields) b.column = changes.fields['Mock_Kanban.Column'];
        if ('Mock_Kanban.Column.Done' in changes.fields) b.done = !!changes.fields['Mock_Kanban.Column.Done'];
        if ('Mock_Kanban.Lane' in changes.fields) b.lane = changes.fields['Mock_Kanban.Lane'];
      }
      w.changedAt = iso(Date.now());
      w.rev++;
      return delay();
    },

    async createWorkItem(projectName, type, fields, parentId) {
      const p = projectById(projectName);
      if (!p.process[type]) throw Object.assign(new Error(`'${type}' is not a work item type in ${p.name}`), { status: 400 });
      if (parentId && !workItems.has(Number(parentId))) throw Object.assign(new Error(`Work item ${parentId} does not exist.`), { status: 400 });
      const w = addWorkItem(p, {
        type, title: fields.title, stateIdx: 0, assignedTo: PEOPLE.find((x) => x.uniqueName === fields.assignedTo) || null,
        priority: fields.priority ? Number(fields.priority) : 2, tags: fields.tags || [], ageDays: 0, stateDays: 0, parentId: parentId ? Number(parentId) : null,
      });
      Object.assign(w, {
        iterationPath: fields.iterationPath || p.name, areaPath: fields.areaPath || p.name, createdBy: ME, storyPoints: null, remainingWork: null,
        createdAt: iso(Date.now()), changedAt: iso(Date.now()), stateChangedAt: iso(Date.now()), _description: fields.description || '', _acceptance: '', _comments: [], _attachments: [],
      });
      return delay({ id: w.id, webUrl: w.webUrl });
    },

    async listAttachments(id) {
      const w = workItems.get(Number(id));
      if (!w) throw notFound(`Work item ${id}`);
      return delay(w._attachments.map(({ by, ...a }) => a));
    },

    async downloadAttachment(attachmentId, name) {
      const seed = Math.floor(Number(String(attachmentId).slice(-12)) / 10);
      const body = demoFile(name, seed);
      return delay({ type: 'application/octet-stream', length: body.length, stream: new Blob([body]).stream() });
    },

    async commentWorkItem(projectName, id, text) {
      const w = workItems.get(Number(id));
      if (!w) throw notFound(`Work item ${id}`);
      w._comments.push({ author: ME, text, createdAt: iso(Date.now()) });
      return delay();
    },

    listBuilds: (projectId, { sinceDays = 14 } = {}) => delay(builds
      .filter((b) => b.projectId === projectById(projectId).id)
      .filter((b) => !b.finishedAt || Date.parse(b.finishedAt) >= Date.now() - sinceDays * D)
      .map((b) => ({ ...b, sourceBranch: b.sourceBranch.replace(/^refs\/heads\//, '') }))),

    listDefinitions(projectId) {
      const p = projectById(projectId);
      const defs = definitions.filter((d) => d.repo.projectId === p.id).map((d) => ({
        id: d.id, name: d.name, path: d.path, projectId: p.id, projectName: p.name, repoId: d.repo.id, repoName: d.repo.name,
        defaultBranch: 'main', paused: false, lastRun: null, webUrl: `${ORG}/${p.name}/_build?definitionId=${d.id}`,
      }));
      // A pipeline that has never run (a repo added recently), so the "No runs" row shows.
      if (p.id === PROJECTS[0].id) {
        const r = p.repoObjs[0];
        defs.push({ id: 990, name: `${r.name}-release-checks`, path: '\\', projectId: p.id, projectName: p.name, repoId: r.id, repoName: r.name, defaultBranch: 'main', paused: false, lastRun: null, webUrl: `${ORG}/${p.name}/_build?definitionId=990` });
      }
      return delay(defs);
    },

    listDefinitionRuns(projectId, definitionId, { top = 25 } = {}) {
      return delay(builds
        .filter((b) => b.projectId === projectById(projectId).id && b.definition.id === Number(definitionId))
        .sort((a, b) => Date.parse(b.queuedAt) - Date.parse(a.queuedAt))
        .slice(0, top)
        .map((b) => ({ ...b })));
    },

    getBuildTimeline(projectId, buildId) {
      const b = builds.find((x) => x.id === Number(buildId));
      return delay(b ? demoTimeline(b) : []);
    },

    getBuildLogTail(projectId, buildId, logId) {
      const b = builds.find((x) => x.id === Number(buildId));
      if (!b) throw notFound('Build');
      return delay(demoLog(b, Number(logId)));
    },

    getBuildChanges(projectId, buildId) {
      const b = builds.find((x) => x.id === Number(buildId));
      if (!b) return delay([]);
      return delay(Array.from({ length: 1 + (b.id % 3) }, (_, i) => ({
        id: (b.id * 7919 + i * 104729).toString(16).padStart(40, 'a').slice(0, 40),
        message: COMMITS[(b.id + i) % COMMITS.length],
        author: DEVS[(b.id + i) % DEVS.length].displayName,
        at: iso(Date.parse(b.queuedAt) - (i + 1) * 40 * 60_000),
        webUrl: `${ORG}/${b.projectName}/_git/${b.repoName || 'repo'}/commit/${b.id}${i}`,
      })));
    },

    getBuildTests(projectId, buildId) {
      const b = builds.find((x) => x.id === Number(buildId));
      if (!b || b.status !== 'completed' || b.result === 'canceled') return delay(null);
      const failed = b.result === 'failed' ? 3 : 0;
      return delay({ total: 412, passed: 412 - failed - 2, failed, other: 2 });
    },

    async queueBuild(projectId, definitionId, branch) {
      const prev = builds.find((b) => b.definition.id === definitionId);
      if (!prev) throw notFound('Pipeline');
      const b = {
        ...prev, id: nextBuild++, status: 'notStarted', result: null, reason: 'manual', sourceBranch: branch || prev.sourceBranch,
        requestedFor: ME, queuedAt: iso(Date.now()), startedAt: null, finishedAt: null, buildNumber: `manual.${nextBuild}`,
      };
      builds.unshift(b);
      // Queued, then running, then done, as in Azure DevOps.
      setTimeout(() => Object.assign(b, { status: 'inProgress', startedAt: iso(Date.now()) }), 15_000).unref?.();
      setTimeout(() => Object.assign(b, { status: 'completed', result: 'succeeded', finishedAt: iso(Date.now()) }), 40_000).unref?.();
      return delay({ id: b.id, webUrl: b.webUrl });
    },
  };
}
