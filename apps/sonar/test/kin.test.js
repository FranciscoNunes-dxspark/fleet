// Sonar in the family: a paste goes to the prompt, /family offers the project to the siblings, and
// Ping's mood goes to them and theirs comes back as a word from Ping. Pure parts first.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeContext, readMoods, takeLine, writeMood } from '../src/family.js';
import { familyChoices, familyMood, pastedLine, reactionLine, reactionTo, trawlLine } from '../src/kin.js';
import { KEYS, start, tempHome, type, until } from './helpers.js';

let cleanup;
before(() => (cleanup = tempHome()));
after(() => cleanup());

const context = encodeContext('commit', { hash: '9b1c7e2d4f60' });

test('what counts as a paste, the lines /family offers, moods in the family\'s words', () => {
  assert.equal(pastedLine(`/take ${context}\r`), `/take ${context}`);
  assert.equal(pastedLine(`\x1b[200~${context}\n\x1b[201~`), context);
  assert.equal(pastedLine('/'), null, 'one key is a key');
  assert.equal(pastedLine('jjj'), null, 'keys typed fast are keys');
  assert.equal(pastedLine('/a\n/b'), null, 'two lines are not one command');

  assert.equal(trawlLine({ name: 'Shop', kind: 'sqlserver', server: 'shop.database.windows.net', database: 'Shop', user: 'app', password: 'p' }), '/azure-sql shop.database.windows.net Shop');
  assert.equal(trawlLine({ name: 'Local', kind: 'sqlserver', server: 'localhost', port: 14330, database: 'Shop', user: 'sa', password: 'p' }), '/add Local localhost,14330 Shop --user sa');
  assert.equal(trawlLine({ name: 'DATABASE_URL', kind: 'postgres', server: 'db.local', port: 5432, database: 'shop', user: 'me', password: 's' }), '/add DATABASE_URL db.local shop --kind postgres --user me');
  const choices = familyChoices({ dir: '/w/shop', repo: '/w/shop', crew: true, httpFiles: ['/w/shop/api/orders.http'], databases: [{ name: 'Shop', source: 'appsettings.json', kind: 'sqlserver', server: 'shop.database.windows.net', database: 'Shop' }] });
  assert.deepEqual(choices.map((c) => [c.app, c.line]), [['splice', '/open /w/shop'], ['bosun', '/move /w/shop'], ['hail', '/open /w/shop/api/orders.http'], ['trawl', '/azure-sql shop.database.windows.net Shop']]);
  assert.equal(choices[2].what, 'api/orders.http');
  assert.ok(choices.every((c) => !/password|\bp\b/i.test(c.line)));

  assert.deepEqual(familyMood('worried', { lastEntry: { title: "Couldn't read the subscription: no\nmore" } }), { mood: 'worried', reason: "Couldn't read the subscription: no" });
  assert.deepEqual(familyMood('look', { busy: { label: 'Querying' } }), { mood: 'busy', reason: 'Querying' });
  assert.deepEqual(familyMood('happy', { lastEntry: { title: 'Restart contoso-web' } }), { mood: 'happy', reason: 'Restart contoso-web' });
  assert.deepEqual(familyMood('wave', { data: { apps: [1, 2], subscription: { name: 'Prod' } } }), { mood: 'neutral', reason: 'watching 2 apps in Prod' });
  const moods = [{ app: 'bosun', mood: 'busy', reason: 'x', at: 3 }, { app: 'splice', mood: 'happy', reason: 'PR #12 merged', at: 2 }, { app: 'hail', mood: 'sad', reason: 'a 500', at: 1 }];
  assert.equal(reactionTo(moods, new Set()).app, 'splice');
  assert.equal(reactionTo(moods, new Set(['splice|2'])).app, 'hail');
  assert.equal(reactionTo(moods, new Set(['splice|2', 'hail|1'])), null);
  assert.equal(reactionLine(moods[1]), 'Twig says: PR #12 merged');
});

test('a command or a context pasted in a view waits in the prompt; ↵ runs it', async () => {
  const app = start();
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('contoso-orders'), 'the apps');
    app.stdin.write('3');
    await until(() => frame().includes('╭─ Problems'), 'Problems');
    app.stdin.write(`${takeLine('commit', { hash: '9b1c7e2d4f60' })}\r`);
    await until(() => frame().includes('> /take family:v1:commit:') && frame().includes('enter run'), 'the paste in the prompt');
    assert.doesNotMatch(frame(), /Deployments of/);
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Deployments of 9b1c7e2d4f'), 'run with ↵');
    app.stdin.write(KEYS.esc);
    await until(() => !frame().includes('Deployments of'), 'closed');
    app.stdin.write('2');
    await until(() => frame().includes('╭─ Logs'), 'Logs');
    app.stdin.write('/kql requests | take 3');
    await until(() => frame().includes('> /kql requests | take 3'), 'a command pasted in Logs');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('3 rows'), 'run');
  } finally {
    app.unmount();
  }
});

test('/family copies a line for each sibling from the folder Sonar started in', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sonar-project-'));
  mkdirSync(join(dir, '.git'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
  writeFileSync(join(dir, 'orders.http'), 'GET http://localhost/orders\n');
  writeFileSync(join(dir, 'appsettings.json'), JSON.stringify({ ConnectionStrings: { Shop: 'Server=tcp:shop.database.windows.net,1433;Database=Shop;User ID=app;Password=hunter2' } }));
  const copied = [];
  const app = start({ cwd: dir, copy: (t) => copied.push(t) });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('contoso-orders'), 'the apps');
    app.stdin.write('/');
    await type(app.stdin, 'family');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('What ') && frame().includes('to the other apps') && frame().includes('Trawl'), 'the choices');
    assert.match(frame(), /❯ Splice\s+\/open /);
    assert.match(frame(), /Bosun\s+\/move /);
    assert.match(frame(), /Hail\s+\/open \S+orders\.http\s+orders\.http/);
    assert.match(frame(), /Trawl\s+\/azure-sql shop\.database\.windows\.net Shop\s+Shop from appsettings\.json/);
    assert.doesNotMatch(frame(), /hunter2/);
    app.stdin.write('G');
    await until(() => /❯ Trawl/.test(frame()), 'the cursor on Trawl');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes("Copied for Trawl: paste it into Trawl's prompt"), 'copied for Trawl');
    assert.equal(copied.at(-1), '/azure-sql shop.database.windows.net Shop');
  } finally {
    app.unmount();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("moods: Ping's goes to the family as it changes, a sibling's comes back once as a word from Ping, and the setting turns both off", async () => {
  const dir = process.env.FAMILY_HOME;
  writeMood('splice', { mood: 'happy', reason: 'PR #12 merged' }, { dir });
  writeMood('bosun', { mood: 'busy', reason: 'starting web' }, { dir });
  const app = start({ familyEvery: 100 });
  const frame = () => app.lastFrame() ?? '';
  const sonar = () => readMoods('splice', { dir }).find((m) => m.app === 'sonar');
  try {
    await until(() => frame().includes('Twig says: PR #12 merged') && frame().includes('(Splice · esc)'), "Twig's word");
    await until(() => sonar()?.reason === 'watching 3 apps in Contoso Production', "Ping's mood written");
    assert.equal(sonar().mood, 'neutral');
    app.stdin.write(KEYS.esc);
    await until(() => !frame().includes('Twig says'), 'put away');
    await new Promise((r) => setTimeout(r, 400));
    assert.doesNotMatch(frame(), /Twig says/, 'said once');
    writeMood('hail', { mood: 'sad', reason: 'POST /orders answered 500' }, { dir });
    await until(() => frame().includes('Hoot says: POST /orders answered 500'), "Hoot's word, later");
    app.stdin.write('/');
    await type(app.stdin, 'sub Nowhere');
    app.stdin.write(KEYS.enter);
    await until(() => sonar()?.mood === 'worried' && sonar().reason === 'No subscription called Nowhere.', 'worried, and why');

    app.stdin.write(',');
    await until(() => frame().includes('Family moods'), 'Settings');
    for (let i = 0; i < 7; i++) app.stdin.write('j');
    await until(() => /❯ Family moods\s+on/.test(frame()), 'the row');
    app.stdin.write(KEYS.enter);
    await until(() => /❯ Family moods\s+off/.test(frame()), 'off');
    assert.ok(!frame().includes('Hoot says'), 'the word goes too');
    rmSync(join(dir, 'sonar.mood.json'));
    writeMood('trawl', { mood: 'worried', reason: 'a long transaction' }, { dir });
    app.stdin.write(KEYS.esc);
    await until(() => !frame().includes('Family moods'), 'Settings closed');
    app.stdin.write('/');
    await type(app.stdin, 'sub Nowhere');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('No subscription called Nowhere'), 'an error');
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(!existsSync(join(dir, 'sonar.mood.json')), 'nothing written');
    assert.doesNotMatch(frame(), /Glim says/, 'nothing heard');
  } finally {
    app.unmount();
  }
});
