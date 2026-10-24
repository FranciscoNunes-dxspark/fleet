// Groups and the after graph: the list's rows, ctrl+g, a group's name in /start, /stop and /restart,
// a profile moving a process, and /graph's tree.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { KEYS, project, start, tempHome, type, until } from './helpers.js';
import { afterTree, crewRows, groupsOf, namedProcs, nextGroup, treeLine } from '../src/groups.js';
import { readSpec, withProfile } from '../src/crew.js';
import { suggestionsFor } from '../src/commands.js';

let cleanup;
before(() => (cleanup = tempHome()));
after(() => cleanup());

const P = (name, group = null, after = null) => ({ name, spec: { group, after } });

test('rows under group headings, the group filter, names that mean a group, and the tree of afters', () => {
  const procs = [P('db'), P('api', 'backend', 'db'), P('web', 'frontend', 'api'), P('worker', 'backend', 'db'), P('e2e', 'frontend', 'web')];
  assert.deepEqual(groupsOf(procs), ['backend', 'frontend']);
  assert.deepEqual(crewRows(procs).map((r) => r.heading ? `# ${r.heading}` : r.p.name), ['db', '# backend', 'api', 'worker', '# frontend', 'web', 'e2e']);
  assert.deepEqual(crewRows(procs, 'frontend').map((r) => r.heading ? `# ${r.heading}` : r.p.name), ['# frontend', 'web', 'e2e']);
  assert.deepEqual(crewRows([P('a'), P('b')]).map((r) => r.p.name), ['a', 'b'], 'no headings without groups');
  assert.deepEqual([null, 'backend', 'frontend'].map((g) => nextGroup(['backend', 'frontend'], g)), ['backend', 'frontend', null]);
  assert.equal(nextGroup([], null), null);
  assert.deepEqual(namedProcs(procs, 'Backend').procs.map((p) => p.name), ['api', 'worker']);
  assert.equal(namedProcs(procs, 'api').group, undefined);
  assert.equal(namedProcs(procs, 'nope'), null);

  const tree = afterTree(procs);
  assert.deepEqual(tree.map(treeLine), ['db', '├─ api', '│  └─ web', '│     └─ e2e', '└─ worker']);
  const circle = afterTree([P('a', null, 'b'), P('b', null, 'a'), P('c')]);
  assert.deepEqual(circle.map((n) => [treeLine(n), n.circle]), [['c', false], ['a', true], ['└─ b', false]]);

  const read = readSpec({ procs: { api: { run: 'x', group: 'backend' }, bad: { run: 'y', group: 'two words' } }, profiles: { solo: { api: { group: 'solo' } }, loose: { api: { group: null } } } });
  assert.equal(read.procs[0].group, 'backend');
  assert.deepEqual(read.problems, ['"bad": "group" is a name: letters, digits, dots, dashes and underscores']);
  assert.equal(withProfile(read.procs, read.profiles, 'solo')[0].group, 'solo');
  assert.equal(withProfile(read.procs, read.profiles, 'loose')[0].group, null);
  const data = { procs: [{ name: 'api', group: 'backend' }, { name: 'web', group: 'frontend' }] };
  assert.deepEqual(suggestionsFor('/stop ba', { data }).map((s) => s.insert), ['/stop backend']);
  assert.deepEqual(suggestionsFor('/stop ', { data }).map((s) => s.insert), ['/stop api', '/stop web', '/stop backend', '/stop frontend', '/stop all']);
});

const IDLE = 'node -e "setInterval(() => {}, 1000)"';

test('the list shows groups; ctrl+g shows one at a time; /stop, /start and /restart take a group; /graph draws the afters', async () => {
  const dir = project({
    procs: {
      db: IDLE,
      api: { run: IDLE, group: 'backend', after: 'db' },
      worker: { run: IDLE, group: 'backend' },
      web: { run: IDLE, group: 'frontend', after: 'api' },
    },
    profiles: { flat: { web: { group: 'backend' } } },
  });
  const app = start({ dir });
  const frame = () => app.lastFrame() ?? '';
  const status = (name) => new RegExp(`${name}\\s+(\\w+)`).exec(frame().split('\n').filter((l) => l.includes(`● ${name}`)).join(''))?.[1];
  try {
    await until(() => ['db', 'api', 'worker', 'web'].every((n) => status(n) === 'running'), 'the crew up');
    assert.match(frame(), /❯ ● db[\s\S]*backend 2\/2[\s\S]*● api[\s\S]*● worker[\s\S]*frontend 1\/1[\s\S]*● web/);

    app.stdin.write('\x07');
    await until(() => frame().includes('Crew · backend') && !frame().includes('● web') && !frame().includes('● db'), 'backend alone');
    assert.match(frame(), /❯ ● api/, 'the cursor on its first process');
    app.stdin.write('\x07');
    await until(() => frame().includes('Crew · frontend') && frame().includes('● web') && !frame().includes('● api'), 'frontend alone');
    app.stdin.write('\x07');
    await until(() => !frame().includes('Crew ·') && frame().includes('● db'), 'all of them again');

    app.stdin.write(':');
    await type(app.stdin, 'stop backend');
    app.stdin.write(KEYS.enter);
    await until(() => status('api') === 'stopped' && status('worker') === 'stopped', 'the group stopped');
    assert.equal(status('web'), 'running');
    assert.equal(status('db'), 'running');
    assert.match(frame(), /backend 0\/2/);
    app.stdin.write(':');
    await type(app.stdin, 'start backend');
    app.stdin.write(KEYS.enter);
    await until(() => status('api') === 'running' && status('worker') === 'running', 'started again');
    app.stdin.write(':');
    await type(app.stdin, 'restart frontend');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Restarting frontend: web'), 'restarting the group');
    await until(() => status('web') === 'running', 'web back');

    app.stdin.write(':');
    await type(app.stdin, 'graph');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Who starts after whom'), 'the tree');
    assert.match(frame(), /│ ● db\s+│\n│ └─ ● api\s+\(backend\)\s+│\n│    └─ ● web\s+\(frontend\)\s+│\n│ ● worker\s+\(backend\)/);
    app.stdin.write(KEYS.esc);
    await until(() => !frame().includes('Who starts after whom'), 'closed');

    app.stdin.write(':');
    await type(app.stdin, 'profile flat');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('backend 3/3') && !frame().includes('frontend'), 'the profile moves web into backend');
  } finally {
    app.stdin.write('q');
    app.unmount();
  }
});
