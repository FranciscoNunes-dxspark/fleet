// Watches: /watch pins a query with a threshold, run every few minutes, telling you when it goes over
// (once, until it's back under); /watches lists them. Pure parts first.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { crossing, parseWatch, watchEvery, watchValue } from '../src/watches.js';
import { settingRows } from '../src/settings.js';
import { demoAzure, demoQuery } from '../src/demo.js';
import { BULLET } from '../src/theme.js';
import { KEYS, start, tempHome, type, until } from './helpers.js';

let cleanup;
before(() => (cleanup = tempHome()));
after(() => cleanup());

test('a watch read from the command line, its number, crossing over only on the way up', () => {
  assert.deepEqual(parseWatch('fails 20 requests | where success == false | count'), { name: 'fails', threshold: 20, kql: 'requests | where success == false | count' });
  assert.deepEqual(parseWatch('slow 0.5 x').threshold, 0.5);
  assert.match(parseWatch('fails lots requests').error, /\/watch <name> <threshold> <kql>/);
  assert.match(parseWatch('').error, /e\.g\./);
  assert.equal(watchValue({ rows: [[12, 'x']] }), 12);
  assert.equal(watchValue({ rows: [['7.5']] }), 7.5);
  assert.equal(watchValue({ rows: [['GET /']] }), null);
  assert.equal(watchValue({ rows: [] }), null);
  assert.deepEqual(crossing(undefined, 30, 20), { above: true, crossed: true });
  assert.deepEqual(crossing(true, 30, 20), { above: true, crossed: false });
  assert.deepEqual(crossing(true, 10, 20), { above: false, crossed: false });
  assert.deepEqual(crossing(false, 21, 20), { above: true, crossed: true });
  assert.deepEqual(crossing(false, 20, 20), { above: false, crossed: false });
  assert.deepEqual(crossing(false, null, 20), { above: false, crossed: false });
  assert.equal(watchEvery({}), 5);
  assert.equal(watchEvery({ watchEvery: 15 }), 15);
  const row = settingRows({ watches: [{}] }).find((r) => r.id === 'watchEvery');
  assert.deepEqual([row.value, row.action, row.note], ['5 min', 'cycle', '15 min next · 1 watch (/watches)']);
  assert.deepEqual(demoQuery('requests | where success == false | count', [{ itemType: 'request', success: false }, { itemType: 'request', success: true }]).rows, [[1]]);
});

test('/watch runs at once and every few minutes, says it once when over, again only after it was under; /watches lists, runs and removes', async () => {
  const provider = demoAzure();
  const values = [5, 25, 30, 3, 40];
  let runs = 0;
  const query = provider.query;
  provider.query = (c, kql, opts) => (kql === 'requests | count' ? (runs++, Promise.resolve({ columns: [{ name: 'Count', type: 'long' }], rows: [[values[Math.min(runs - 1, values.length - 1)]]] })) : query(c, kql, opts));
  const told = [];
  const app = start({ provider, config: { history: [], watchEvery: 0.004 }, notify: (title, body) => told.push([title, body]) });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('contoso-orders'), 'the apps');
    app.stdin.write('/');
    await type(app.stdin, 'watch busy 20 requests | count');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Watching "busy" in contoso-prod-ai: over 20 says so'), 'the watch made');
    const saved = JSON.parse(readFileSync(join(process.env.SONAR_HOME, 'config.json'), 'utf8')).watches;
    assert.deepEqual(saved.map((w) => [w.name, w.threshold, w.kql, w.component.name, w.component.appId]), [['busy', 20, 'requests | count', 'contoso-prod-ai', 'app-prod']]);
    await until(() => runs >= 5, 'five runs');
    assert.deepEqual(told, [['Sonar: busy is over 20', '25 in contoso-prod-ai'], ['Sonar: busy is over 20', '40 in contoso-prod-ai']]);
    assert.match(frame(), /Watch "busy" is 40, over 20/);

    app.stdin.write('/');
    await type(app.stdin, 'watches');
    app.stdin.write(KEYS.enter);
    await until(() => new RegExp(`❯ ${BULLET} busy\\s+40\\s+over 20\\s+contoso-prod-ai\\s+requests \\| count`).test(frame()), 'the watch listed with its last value');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('╭─ Logs') && frame().includes('> requests | count'), 'its query in Logs');
    app.stdin.write('/');
    await type(app.stdin, 'watches');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Watches, every'), 'the list again');
    app.stdin.write('x');
    await until(() => frame().includes('Stopped watching "busy"') && frame().includes('No watches left'), 'removed');
    assert.deepEqual(JSON.parse(readFileSync(join(process.env.SONAR_HOME, 'config.json'), 'utf8')).watches, []);
    const after = runs;
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(runs, after, 'a removed watch runs no more');
  } finally {
    app.unmount();
  }
});
