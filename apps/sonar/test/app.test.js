// Drives the real UI over the demo Azure: keys in, frames out, the demo's state checked.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { KEYS, start, tempHome, type, until } from './helpers.js';

let cleanup;
before(() => (cleanup = tempHome()));
after(() => cleanup());

const settingsOf = (app, name) => app.provider.state.sites.find((s) => `${s.name}${s.slot ? `/${s.slot}` : ''}` === name).settings;

test('resources: the tree, an app beside it, its settings with secrets hidden, slots compared', async () => {
  const copied = [];
  const app = start({ copy: (t) => copied.push(t) });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('contoso-orders') && frame().includes('insights  contoso-prod-ai'), 'the apps, and the first one beside them');
    assert.match(frame(), /DEMO/);
    assert.match(frame(), /❯ ● contoso-web/);
    assert.match(frame(), /production: changes ask you to type its name/);

    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Settings of contoso-web'), 'the settings');
    assert.match(frame(), /Db__ConnectionString\s+••••••/);
    assert.doesNotMatch(frame(), /demo-Pa55w0rd/);
    for (let i = 0; i < 3; i++) {
      app.stdin.write('j');
      await new Promise((r) => setTimeout(r, 30));
    }
    await until(() => /❯ Db__ConnectionString/.test(frame()), 'the cursor on the secret');
    app.stdin.write('v');
    await until(() => frame().includes('Server=tcp:contoso-prod'), 'the secret shown on asking');
    app.stdin.write('d');
    await until(() => frame().includes('contoso-web → contoso-web/staging: 3 settings differ'), 'the slots compared');
    assert.match(frame(), /APP_VERSION/);
    assert.match(frame(), /\+ contoso-web\/staging: 2\.15\.0-rc\.1/);
    app.stdin.write(KEYS.esc);
    await until(() => frame().includes('Settings of contoso-web'), 'back to the settings');

    // Editing one: production asks for the app's name.
    app.stdin.write('g');
    await until(() => /❯ APP_VERSION/.test(frame()), 'the cursor on APP_VERSION');
    app.stdin.write('e');
    await until(() => frame().includes('APP_VERSION on contoso-web'), 'its value to edit');
    for (let i = 0; i < 6; i++) app.stdin.write(KEYS.backspace);
    await type(app.stdin, '3.0.0');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Type contoso-web to go ahead'), 'the name asked for');
    await type(app.stdin, 'contoso-web');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Saved; the app restarts'), 'saved');
    assert.equal(settingsOf(app, 'contoso-web').APP_VERSION, '3.0.0');
  } finally {
    app.unmount();
  }
});

test('changes: restart asks for production\'s name and refuses a wrong one, a swap moves the settings, a dev app stops after a yes', async () => {
  const app = start();
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('contoso-orders'), 'the apps');
    app.stdin.write('R');
    await until(() => frame().includes('Restart contoso-web? Type contoso-web to go ahead'), 'the name asked for');
    await type(app.stdin, 'contoso-api');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes("That isn't contoso-web, so nothing was changed"), 'a wrong name refused');

    app.stdin.write('j');
    await until(() => /❯\s+└ ● staging/.test(frame()), 'the staging slot');
    app.stdin.write('W');
    await until(() => frame().includes('Swap contoso-web/staging into production? Type contoso-web'), 'the swap asked about');
    assert.match(frame(), /3 settings differ/);
    await type(app.stdin, 'contoso-web');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Swapping contoso-web/staging into production'), 'swapped');
    assert.equal(settingsOf(app, 'contoso-web').APP_VERSION, '2.15.0-rc.1');
    assert.equal(settingsOf(app, 'contoso-web/staging').APP_VERSION, '2.14.0');

    app.stdin.write('/');
    await type(app.stdin, 'sub Contoso Dev');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('contoso-web-dev') && frame().includes('Contoso Dev'), 'the other subscription');
    app.stdin.write('S');
    await until(() => frame().includes('Stop contoso-web-dev?') && frame().includes('Yes, stop it'), 'a plain question for dev');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('contoso-web-dev stopped') && frame().includes('Stopped'), 'stopped');
  } finally {
    app.unmount();
  }
});

test('logs: an app\'s requests, a query typed with completion, a row whole; problems and an operation; the span', async () => {
  const app = start();
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('contoso-orders'), 'the apps');
    app.stdin.write('l');
    await until(() => frame().includes('╭─ Logs') && frame().includes('50 rows'), "the app's latest requests");
    assert.match(frame(), /contoso-prod-ai · contoso-web/);
    assert.match(frame(), /timestamp\s+│ name/);

    app.stdin.write('e');
    await until(() => frame().includes('tab') || frame().includes('> requests'), 'editing');
    app.stdin.write('\x15'); // ctrl+u clears it
    await type(app.stdin, 'exc');
    await until(() => frame().includes('exceptions') && frame().includes('tab completes'), 'a table suggested');
    app.stdin.write(KEYS.tab);
    await type(app.stdin, ' | take 3');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('3 rows'), 'three exceptions');
    assert.match(frame(), /problemId/);
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Row 1 of 3') && frame().includes('"outerMessage"'), 'the row whole');
    app.stdin.write(KEYS.esc);
    await until(() => frame().includes('3 rows'), 'back');

    app.stdin.write('3');
    await until(() => frame().includes('TimeoutException') && /\d+ problems/.test(frame()), 'the problems');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('the latest occurrence') && /operation op-/.test(frame()) && /\d\d:\d\d:\d\d\s+exception/.test(frame()), 'the operation');
    app.stdin.write(KEYS.esc);
    await until(() => !frame().includes('esc close'), 'closed');

    app.stdin.write('t');
    await until(() => frame().includes('last 7d'), 'the span changed');
  } finally {
    app.unmount();
  }
});
