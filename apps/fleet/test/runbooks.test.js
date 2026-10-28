import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { draftRunbook, listRunbooks, parseRunbook, runbookDirs, writeDraft } from '../src/runbooks.js';

const EXAMPLE = `# Is the API healthy?

Start the crew.

\`\`\`bosun
/start api
\`\`\`

Then ask it, twice.
## Ask

\`\`\`hail
/send health

/send version
\`\`\`

\`\`\`bash
curl localhost
\`\`\`

\`\`\`notes
not an app
\`\`\`

Done.
`;

test('a step per line of a block named after an app, the prose before it on its first line', () => {
  const r = parseRunbook(EXAMPLE);
  assert.equal(r.title, 'Is the API healthy?');
  assert.deepEqual(r.steps, [
    { app: 'bosun', line: '/start api', prose: 'Start the crew.' },
    { app: 'hail', line: '/send health', prose: 'Then ask it, twice.\nAsk' },
    { app: 'hail', line: '/send version', prose: '' },
  ]);
  // Other blocks are prose, as they are.
  assert.equal(r.outro, 'curl localhost\n\nnot an app\n\nDone.');
});

test('no heading names it after its file; tildes, longer fences and a block left open count', () => {
  const r = parseRunbook('~~~~Trawl\n/connect prod\n```\n~~~~\n\n````sonar\n/take x', { name: 'db' });
  assert.equal(r.title, 'db');
  assert.deepEqual(r.steps.map((s) => [s.app, s.line]), [['trawl', '/connect prod'], ['trawl', '```'], ['sonar', '/take x']]);
  assert.deepEqual(parseRunbook('```one\nx\n```', { ids: ['one'] }).steps, [{ app: 'one', line: 'x', prose: '' }]);
});

test('runbooks are read from the start folder, its checkout and Fleet\'s home', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'fleet-runbooks-'));
  const repo = join(tmp, 'repo');
  const sub = join(repo, 'api');
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(join(sub, '.fleet', 'runbooks'), { recursive: true });
  mkdirSync(join(repo, '.fleet', 'runbooks'), { recursive: true });
  writeFileSync(join(sub, '.fleet', 'runbooks', 'b.md'), '# B\n```hail\n/send\n```\n');
  writeFileSync(join(sub, '.fleet', 'runbooks', 'a.md'), 'no steps');
  writeFileSync(join(sub, '.fleet', 'runbooks', 'skip.txt'), 'x');
  writeFileSync(join(repo, '.fleet', 'runbooks', 'c.md'), '# C');
  const dirs = runbookDirs({ cwd: sub, env: { FLEET_HOME: join(tmp, 'home') } });
  assert.deepEqual(dirs, [join(sub, '.fleet', 'runbooks'), join(repo, '.fleet', 'runbooks'), join(tmp, 'home', 'runbooks')]);
  const list = listRunbooks(dirs, { cwd: sub });
  assert.deepEqual(list.map((r) => [r.name, r.title, r.steps.length, r.where]), [
    ['a', 'a', 0, '.fleet/runbooks'],
    ['b', 'B', 1, '.fleet/runbooks'],
    ['c', 'C', 0, join(repo, '.fleet', 'runbooks')],
  ]);
});

test('a draft says what happened, honestly, with an empty step to fill in', () => {
  const now = new Date(2026, 9, 27, 15, 4).getTime();
  const entries = [
    { at: now - 60_000, app: 'bosun', text: 'Restarted api' },
    { at: now - 120_000, app: 'splice', text: 'Pushed main\nto origin' },
  ];
  const text = draftRunbook(entries, { now });
  assert.match(text, /^# Draft of 2026-10-27 15:04\n/);
  assert.match(text, /not the commands that did it/);
  assert.match(text, /- 15:02 Splice: Pushed main to origin\n- 15:03 Bosun: Restarted api\n/);
  // The empty block is Bosun's, which did the last thing, and makes no step.
  assert.match(text, /```bosun\n```\n$/);
  assert.equal(parseRunbook(text).steps.length, 0);
  assert.match(draftRunbook([], { now }), /Nothing in the last hour/);

  const dir = join(mkdtempSync(join(tmpdir(), 'fleet-draft-')), '.fleet', 'runbooks');
  const first = writeDraft(dir, text, { now });
  const second = writeDraft(dir, 'again', { now });
  assert.equal(first, join(dir, '2026-10-27-draft.md'));
  assert.equal(second, join(dir, '2026-10-27-draft-2.md'));
  assert.equal(readFileSync(first, 'utf8'), text);
});
