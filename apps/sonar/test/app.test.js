// Drives the real UI over the demo Azure: keys in, frames out, the demo's state checked.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { demoAzure } from '../src/demo.js';
import { LIGHT, applyTheme, theme } from '../src/theme.js';
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
    // Put the welcome away, for room.
    app.stdin.write(KEYS.esc);
    await until(() => /cpu\s+\S+.*\d.* cpu/.test(frame()) && /memory\s+\S+.*MB · peak/.test(frame()) && /5xx\s/.test(frame()), 'its metrics as sparklines');
    assert.match(frame(), /the last 24h/);

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

test('opened from the command line: an address finds its app, Problems about it; an app by name in Logs, a row as a Hail request', async () => {
  const copied = [];
  let app = start({ open: { url: 'https://shop.contoso.com/health', view: 'problems' } });
  let frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('╭─ Problems') && frame().includes('contoso-prod-ai · contoso-web') && /\d+ problems/.test(frame()), 'the problems of the app behind the address');
    app.stdin.write('1');
    await until(() => /❯ ● contoso-web/.test(frame()), 'Resources on that app');
  } finally {
    app.unmount();
  }
  app = start({ open: { sub: 'Contoso Production', app: 'contoso-api', view: 'logs' }, copy: (t) => copied.push(t) });
  frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('╭─ Logs') && frame().includes('contoso-prod-ai · contoso-api') && frame().includes('50 rows'), "the app's requests");
    app.stdin.write('H');
    await until(() => frame().includes('Copied it as a Hail request'), 'the copy');
    assert.match(copied.at(-1), /^### GET \/\S* \(answered \d+\)\nGET https:\/\/contoso-api\.azurewebsites\.net\/\S*\n$/);
  } finally {
    app.unmount();
  }
  app = start({ open: { app: 'no-such-app', url: 'https://nowhere.example.com/' } });
  frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes("There's no app called no-such-app") && frame().includes('No app in Contoso Production serves'), 'both said');
  } finally {
    app.unmount();
  }
});

test("live: an app's log as it's written, paused, and stopped once you leave", async () => {
  const provider = demoAzure();
  let lines = 0;
  const stream = provider.logStream;
  provider.logStream = (t, opts) => stream(t, { ...opts, every: 40, onLine: (l) => (lines++, opts.onLine(l)) });
  const app = start({ provider });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('contoso-orders'), 'the apps');
    app.stdin.write('L');
    await until(() => frame().includes('Live: contoso-web') && frame().includes('Streaming the log of contoso-web') && /\[(INF|WRN|ERR)\]/.test(frame()), 'the log streaming');
    assert.match(frame(), / live · p pause/);
    app.stdin.write('p');
    await until(() => frame().includes('paused (p goes on)'), 'paused');
    app.stdin.write('1');
    await until(() => frame().includes('╭─ Contoso Production'), 'Resources again');
    const after = lines;
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(lines, after, 'the stream stopped when Live went off screen');
  } finally {
    app.unmount();
  }
});

test('settings: the theme goes dark, light, auto, and the screen takes it at once', async () => {
  const app = start();
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('contoso-orders'), 'the apps');
    app.stdin.write(',');
    await until(() => /❯ Theme\s+auto/.test(frame()), 'the theme row first');
    app.stdin.write(KEYS.enter);
    await until(() => /❯ Theme\s+dark\s+↵ light next/.test(frame()), 'dark');
    app.stdin.write(KEYS.enter);
    await until(() => /❯ Theme\s+light/.test(frame()), 'light');
    assert.equal(theme.mode, 'light');
    assert.equal(theme.del, LIGHT.del);
    const saved = JSON.parse(readFileSync(join(process.env.SONAR_HOME, 'config.json'), 'utf8'));
    assert.equal(saved.theme, 'light');
  } finally {
    app.unmount();
    applyTheme({ theme: 'dark' }, {});
  }
});

test('a long job ends with a notification, a quick one and a cancelled one say nothing, and Settings turns it off', async () => {
  const told = [];
  const app = start({ config: { history: [], notifyAfter: 0.4 }, notify: (title, body) => told.push([title, body]) });
  const frame = () => app.lastFrame() ?? '';
  const command = async (line) => {
    app.stdin.write('/');
    await type(app.stdin, line);
    app.stdin.write(KEYS.enter);
  };
  try {
    await until(() => frame().includes('contoso-orders'), 'the apps');
    await command('run echo quick');
    await until(() => frame().includes('quick') && !frame().includes('esc to cancel'), 'a quick job');
    await command('run node -e "setTimeout(() => console.log(42), 700)"');
    await until(() => told.length === 1, 'the notification');
    assert.match(told[0][0], /^Sonar: node -e/);
    assert.equal(told[0][1], '42');
    await command('run node -e "setTimeout(() => {}, 5000)"');
    await until(() => frame().includes('esc to cancel'), 'a slow job');
    await new Promise((r) => setTimeout(r, 600));
    app.stdin.write(KEYS.esc);
    await until(() => frame().includes('Cancelled'), 'cancelled');
    assert.equal(told.length, 1, 'a cancelled job says nothing');

    app.stdin.write(',');
    await until(() => frame().includes('Notify when done'), 'Settings');
    for (let i = 0; i < 5; i++) app.stdin.write('j');
    await until(() => /❯ Notify when done\s+on/.test(frame()), 'the notify row');
    app.stdin.write(KEYS.enter);
    await until(() => /❯ Notify when done\s+off/.test(frame()), 'turned off');
    app.stdin.write(KEYS.esc);
    await until(() => !frame().includes('Notify when done'), 'Settings closed');
    await command('run node -e "setTimeout(() => {}, 700)"');
    await until(() => frame().includes('esc to cancel'), 'another slow job');
    await until(() => !frame().includes('esc to cancel'), 'its end');
    assert.equal(told.length, 1);
  } finally {
    app.unmount();
  }
});

test('problems: w asks Claude why, with the latest occurrence on stdin and read-only tools, and /why names one', async () => {
  const asked = [];
  const askClaude = async (prompt, opts) => {
    asked.push({ prompt, ...opts });
    return 'The payments provider is slow: raise the HttpClient timeout in PaymentsClient.';
  };
  const app = start({ askClaude });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('contoso-orders'), 'the apps');
    app.stdin.write('3');
    await until(() => frame().includes('TimeoutException') && /\d+ problems/.test(frame()), 'the problems');
    app.stdin.write('w');
    await until(() => frame().includes('╭─ Why ') && frame().includes('raise the HttpClient timeout'), "Claude's answer in the viewer");
    const [q] = asked;
    const kind = /^"([^"]+)" is an exception in the Azure app "contoso-web"/.exec(q.prompt)?.[1];
    assert.ok(kind, q.prompt);
    assert.ok(frame().includes(`Why ${kind}`));
    assert.deepEqual(q.tools, ['Read', 'Grep', 'Glob']);
    assert.equal(q.cwd, process.cwd());
    assert.match(q.input, /request\s+GET \//);
    assert.ok(q.input.includes(`exception    ${kind}`), q.input);
    assert.match(q.input, /dependency\s+POST \/charges/);
    app.stdin.write(KEYS.esc);
    await until(() => !frame().includes('╭─ Why '), 'closed');

    app.stdin.write('/');
    await type(app.stdin, 'why Timeout');
    await until(() => frame().includes('System.TimeoutException at'), 'completion offers the problem');
    app.stdin.write(KEYS.enter);
    await until(() => asked.length === 2 && frame().includes('Why System.TimeoutException'), 'the named one asked about');
    assert.match(asked[1].input, /timed out talking to the payments provider/);
  } finally {
    app.unmount();
  }
});
