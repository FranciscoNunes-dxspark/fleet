// The family's timeline and wiring from Sonar: what it logs when it changes something, /timeline and /wiring.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { logActivity, readActivity } from '../src/family.js';
import { KEYS, start, tempHome, type, until } from './helpers.js';

let cleanup;
before(() => (cleanup = tempHome()));
after(() => cleanup());

test('a change, and a watch going over, go to the family\'s activity; /timeline shows them all or this project\'s; /wiring masks secrets', async () => {
  const project = join(process.env.SONAR_HOME, 'shop');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'appsettings.json'), JSON.stringify({ ConnectionStrings: { Default: 'Server=tcp:contoso-sql-prod.database.windows.net;Database=contoso;User ID=app;Password=hunter2;' }, Payments: { BaseUrl: 'https://payments.example.com' } }));
  logActivity('splice', { text: 'pushed main to origin (2 commits)', kind: 'push', project: join(process.env.SONAR_HOME, 'elsewhere') }, { now: Date.now() - 60_000 });
  const app = start({ cwd: project });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('contoso-orders'), 'the apps');
    app.stdin.write('/');
    await type(app.stdin, 'restart contoso-web');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Type contoso-web to go ahead'), 'the question');
    await type(app.stdin, 'contoso-web');
    app.stdin.write(KEYS.enter);
    await until(() => readActivity().some((e) => e.app === 'sonar'), 'the restart logged');
    const [mine] = readActivity();
    assert.deepEqual([mine.app, mine.kind, mine.text, mine.project], ['sonar', 'restart', 'restarted contoso-web (Contoso Production)', resolve(project)]);

    app.stdin.write('/');
    await type(app.stdin, 'watch failing 0 requests | where success == false | count');
    app.stdin.write(KEYS.enter);
    await until(() => readActivity().some((e) => e.kind === 'alert'), 'the watch logged');
    assert.match(readActivity().find((e) => e.kind === 'alert').text, /^watch "failing" is \d+, over 0 in contoso-prod-ai/);

    app.stdin.write('/');
    await type(app.stdin, 'timeline');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Timeline: the family (3)'), 'the timeline');
    assert.match(frame(), /now\s+Sonar\s+watch "failing"/);
    assert.match(frame(), /now\s+Sonar\s+restarted contoso-web \(Contoso Production\)\s+shop/);
    assert.match(frame(), /1m\s+Splice\s+pushed main to origin \(2 commits\)\s+elsewhere/);
    app.stdin.write('p');
    await until(() => frame().includes('Timeline of shop (2)'), 'this project only');
    assert.doesNotMatch(frame(), /pushed main/);
    app.stdin.write('j');
    await until(() => /❯\s+now\s+Sonar\s+restarted/.test(frame()), 'the cursor on the restart');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Sonar: restart') && frame().includes(`project  ${resolve(project)}`), 'the entry whole');
    app.stdin.write(KEYS.esc);
    await until(() => frame().includes('Timeline of shop'), 'back to the timeline');
    app.stdin.write(KEYS.esc);
    await until(() => !frame().includes('Timeline'), 'closed');

    app.stdin.write('/');
    await type(app.stdin, 'wiring');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('points at (2)') && frame().includes('appsettings.json'), 'the wiring');
    assert.match(frame(), /ConnectionStrings:Default/);
    assert.match(frame(), /Server=tcp:contoso-sql-prod\.database\.windows\.net;/);
    assert.match(frame(), /Password=••••/);
    assert.match(frame(), /Payments:BaseUrl\s+https:\/\/payments\.example\.com/);
    assert.doesNotMatch(frame(), /hunter2/);
  } finally {
    app.unmount();
  }
});
