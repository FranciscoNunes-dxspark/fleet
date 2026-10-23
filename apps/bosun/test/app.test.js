// Drives the real UI with a real crew of small node scripts: keys in, frames out.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { KEYS, project, quietCrew, start, tempHome, type, until } from './helpers.js';

let cleanup;
before(() => (cleanup = tempHome()));
after(() => cleanup());

const freePort = () =>
  new Promise((done) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => done(port));
    });
  });

const SERVER = `require('http').createServer((q, s) => s.end('ok')).listen(+process.env.PORT, '127.0.0.1', () => console.log('listening on ' + process.env.PORT));`;
const TICKER = `let n = 0; setInterval(() => console.log('tick ' + ++n), 100);`;
const CRASH = `console.log('connecting'); setTimeout(() => { console.error('Error: the queue is not there'); process.exit(2); }, 150);`;

test('the crew starts, shows each log, restarts, stops, crashes, asks Claude why, and stops it all on quit', async () => {
  const port = await freePort();
  const dir = project(
    { procs: { api: { run: 'node server.js', port, env: { PORT: String(port) } }, ticker: 'node ticker.js', queue: 'node crash.js' }, profiles: { slow: { ticker: { env: { SLOW: '1' } } } } },
    { 'server.js': SERVER, 'ticker.js': TICKER, 'crash.js': CRASH },
  );
  const asked = [];
  const opened = [];
  const askClaude = async (prompt, { input, cwd }) => {
    asked.push({ prompt, input, cwd });
    return 'The queue service is not running: start it first.';
  };
  const app = start({ dir, askClaude, openUrl: (u) => opened.push(u) });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes(`listening on ${port}`), 'the api up, its log beside the list');
    assert.match(frame(), /❯ ● api\s+running/);
    await until(() => /queue\s+crashed/.test(frame()) && frame().includes('1 crashed'), 'the crash, in the list and the header');
    await until(() => frame().includes(`:${port} ✓`), 'the port answering');

    app.stdin.write('j');
    await until(() => /tick \d+/.test(frame()), 'the ticker\'s log');
    app.stdin.write('a');
    await until(() => frame().includes('╭─ All') && /ticker\s+tick/.test(frame()), 'every log at once');
    app.stdin.write('a');
    await until(() => !frame().includes('╭─ All'), 'back to the one');

    app.stdin.write('s');
    await until(() => /ticker\s+stopped/.test(frame()), 'the ticker stopped');
    app.stdin.write('s');
    await until(() => /ticker\s+running/.test(frame()), 'and started again');

    app.stdin.write('j');
    await until(() => /❯ ● queue/.test(frame()), 'on the crashed one');
    app.stdin.write('w');
    await until(() => frame().includes('The queue service is not running'), 'Claude\'s answer in the viewer');
    assert.match(asked[0].input, /the queue is not there/);
    assert.match(asked[0].prompt, /exit code 2/);
    assert.equal(asked[0].cwd, dir);
    app.stdin.write(KEYS.esc);
    await until(() => !frame().includes('esc close'), 'the answer closed');

    app.stdin.write('k');
    app.stdin.write('k');
    await until(() => /❯ ● api/.test(frame()), 'back on the api');
    app.stdin.write('o');
    await until(() => opened.length === 1, 'the browser asked for');
    assert.deepEqual(opened, [`http://localhost:${port}`]);
    app.stdin.write('r');
    await until(() => (frame().match(/listening on/g) ?? []).length >= 2, 'the api restarted');

    app.stdin.write(':');
    await type(app.stdin, 'profile slow');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('profile slow'), 'the profile in the header');

    app.stdin.write('q');
    // Quitting unmounts App, which stops everything: the port is let go.
    await until(async () => true, 'quit');
  } finally {
    app.unmount();
  }
  const { portOpen } = await import('../src/supervisor.js');
  const end = Date.now() + 5000;
  while ((await portOpen(port)) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  assert.equal(await portOpen(port), false, 'nothing left listening after Bosun closed');
});

test('new lines redraw only when their log is on screen, and a log shown again is up to date', async () => {
  const dir = project({ procs: { quiet: `node -e "console.log('hello'); setInterval(() => {}, 1e6)"`, ticker: 'node ticker.js' } }, { 'ticker.js': TICKER });
  const app = start({ dir });
  const frame = () => app.lastFrame() ?? '';
  const tick = () => Number(/tick (\d+)/.exec(frame())?.[1] ?? 0);
  try {
    await until(() => frame().includes('hello') && /ticker\s+running/.test(frame()), 'the quiet one\'s log');
    const before = app.frames.length;
    await new Promise((r) => setTimeout(r, 700));
    // The ticker said seven lines meanwhile; at most the uptimes' second went by on screen.
    assert.ok(app.frames.length - before <= 1, `${app.frames.length - before} frames for a log not on screen`);
    app.stdin.write('j');
    await until(() => tick() >= 7, 'the ticker\'s log, as it is now');
    const now = tick();
    await until(() => tick() >= now + 3, 'its new lines as they come');
    app.stdin.write('a');
    await until(() => frame().includes('╭─ All') && /ticker\s+tick/.test(frame()), 'every log at once');
    const merged = tick();
    await until(() => tick() >= merged + 3, 'new lines in the All pane');
  } finally {
    app.unmount();
  }
});

test('/free asks, then stops what holds the port; /init writes bosun.json from package.json', async () => {
  const dir = project({});
  const { rmSync } = await import('node:fs');
  rmSync(`${dir}/bosun.json`);
  writeFileSync(`${dir}/package.json`, JSON.stringify({ scripts: { dev: 'concurrently -n api,web "node -e 1" "node -e 2"' } }));
  const killed = [];
  const app = start({ dir, autostart: false, pidsOnPort: (p) => (p === 3000 ? [4242] : []), killPids: (pids) => killed.push(...pids) });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes("package.json's dev script") && /web\s+stopped/.test(frame()), 'the crew from package.json');
    app.stdin.write(':');
    await type(app.stdin, 'free 3000');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Stop process 4242, which holds port 3000?'), 'the question');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Stopped what held port 3000'), 'done');
    assert.deepEqual(killed, [4242]);

    app.stdin.write(':');
    await type(app.stdin, 'init');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Wrote bosun.json'), 'written');
    const spec = JSON.parse(readFileSync(`${dir}/bosun.json`, 'utf8'));
    assert.deepEqual(Object.keys(spec.procs), ['api', 'web']);
    await until(() => frame().includes('│  bosun.json'), 'read from it now');
  } finally {
    app.unmount();
  }
});

test('! runs a shell command, with its output in the activity lines, and esc cancels a slow one', async () => {
  const app = start();
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('worker'), 'the crew');
    app.stdin.write('!');
    await type(app.stdin, 'node -e "console.log(6*7)"');
    app.stdin.write(KEYS.enter);
    await until(() => /⎿\s+42/.test(frame()), 'the output');

    app.stdin.write('!');
    await type(app.stdin, 'node -e "setTimeout(() => {}, 20000)"');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('esc to cancel'), 'the spinner');
    app.stdin.write(KEYS.esc);
    await until(() => frame().includes('Cancelled'), 'the command cancelled');

    // Both are in the prompt's history, newest first.
    const saved = JSON.parse(readFileSync(join(process.env.BOSUN_HOME, 'config.json'), 'utf8'));
    assert.equal(saved.history.length, 2);
    assert.match(saved.history[0], /setTimeout/);
  } finally {
    app.unmount();
  }
});

test('settings: a toggle saves, the accent changes through its command', async () => {
  const app = start();
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('worker'), 'the crew');
    app.stdin.write(',');
    await until(() => frame().includes('Accent colour'), 'the settings');
    assert.match(frame(), /❯ Theme\s+auto \(dark here\)\s+↵ dark next/);
    app.stdin.write(KEYS.enter);
    await until(() => /❯ Theme\s+dark\s+↵ light next/.test(frame()), 'dark');
    app.stdin.write(KEYS.enter);
    await until(() => /❯ Theme\s+light/.test(frame()) && /Accent colour\s+■ #d75f5f \(default\)/.test(frame()), 'light, with its own accent');
    const { theme } = await import('../src/theme.js');
    assert.equal(theme.mode, 'light');
    assert.equal(theme.ink, '#ffffff');
    app.stdin.write(KEYS.enter);
    await until(() => /❯ Theme\s+auto/.test(frame()), 'back to auto');
    assert.equal(theme.mode, 'dark');
    app.stdin.write('j');
    app.stdin.write('j');
    await until(() => /❯ Mouse\s+on/.test(frame()), 'the cursor on Mouse');
    app.stdin.write(KEYS.enter);
    await until(() => /❯ Mouse\s+off/.test(frame()), 'the mouse off');
    const saved = () => JSON.parse(readFileSync(join(process.env.BOSUN_HOME, 'config.json'), 'utf8'));
    assert.equal(saved().mouse, false);

    app.stdin.write('k');
    await until(() => /❯ Accent colour/.test(frame()), 'the cursor on the accent');
    assert.equal(saved().theme, 'auto');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('/accent #ff6b6b'), 'the prompt filled in');
    for (let i = 0; i < 7; i++) app.stdin.write(KEYS.backspace);
    await type(app.stdin, '#ff8800');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('#ff8800'), 'the new accent in the list');
    assert.equal(saved().accent, '#ff8800');
  } finally {
    app.unmount();
  }
});

test('/move asks, stops this project\'s crew, and runs the other\'s; it\'s remembered', async () => {
  const port = await freePort();
  const shop = project({ procs: { api: { run: 'node server.js', port, env: { PORT: String(port) } } } }, { 'server.js': SERVER });
  const blog = project({ procs: { feed: 'node ticker.js' } }, { 'ticker.js': TICKER });
  const { basename } = await import('node:path');
  const app = start({ dir: shop });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes(`listening on ${port}`), 'the shop\'s api up');
    assert.ok(frame().includes(basename(shop)), 'the project in the header');

    app.stdin.write(':');
    await type(app.stdin, `move ${basename(blog)}`);
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes(`Stop the running process and move to ${basename(blog)}?`), 'the question');
    app.stdin.write(KEYS.enter);
    await until(() => /❯ ● feed\s+running/.test(frame()) && /tick \d+/.test(frame()), 'the blog\'s crew running');
    assert.ok(frame().includes(basename(blog)) && !frame().includes(' api '), 'the other project, and nothing of the first');

    const { portOpen } = await import('../src/supervisor.js');
    const end = Date.now() + 5000;
    while ((await portOpen(port)) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    assert.equal(await portOpen(port), false, 'the first project\'s api stopped');
    const saved = JSON.parse(readFileSync(join(process.env.BOSUN_HOME, 'config.json'), 'utf8'));
    assert.deepEqual(saved.projects.slice(0, 2), [blog, shop], 'both remembered, the newest first');

    app.stdin.write(':');
    await type(app.stdin, `move ${basename(blog)}`);
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes(`Bosun is in ${basename(blog)} already`), 'nowhere to go');
  } finally {
    app.unmount();
  }
});

test('a crew that can\'t be read says so, and /reload tries again', async () => {
  let calls = 0;
  const quiet = quietCrew(['only']);
  const load = async () => {
    if (++calls === 1) throw new Error('bosun.json isn\'t valid JSON');
    return quiet();
  };
  const app = start({ load, autostart: false });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes("Couldn't read the crew: bosun.json isn't valid JSON"), 'the error');
    app.stdin.write('/');
    await type(app.stdin, 'reload');
    app.stdin.write(KEYS.enter);
    await until(() => /❯ ● only/.test(frame()), 'the second read');
  } finally {
    app.unmount();
  }
});

test('a process that restarts says when, s stops it waiting, and one that keeps failing gives up', async () => {
  const dir = project({ procs: { first: { run: 'node crash.js', restart: 'on-failure' }, second: { run: 'node crash.js', restart: 'always' } } }, { 'crash.js': `console.log('up'); process.exit(1);` });
  const app = start({ dir, restartTimes: { first: 2500, max: 2500, stable: 60_000, quick: 60_000, giveUpAfter: 2 } });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => /first\s+restarting in [123]s/.test(frame()) && /second\s+restarting in/.test(frame()), 'both waiting to restart');
    app.stdin.write('s');
    await until(() => /❯ ● first\s+crashed\s+code 1/.test(frame()), 'the first not restarting');
    await until(() => /second\s+crashed\s+gave up/.test(frame()), 'the second gave up', 10_000);
    assert.match(frame(), /second gave up: it ended 2 times in a row/);
    assert.match(frame(), /first\s+crashed\s+code 1/, 'and the first never came back');
  } finally {
    app.unmount();
  }
});

test('a changed env file restarts the process that reads it on /reload', async () => {
  const dir = project({ procs: { api: { run: 'node show.js', envFile: '.env' }, other: 'node -e "setInterval(() => {}, 1000)"' } }, {
    '.env': 'GREETING=hello',
    'show.js': 'console.log("greeting " + process.env.GREETING); setInterval(() => {}, 1000);',
  });
  const app = start({ dir });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('greeting hello'), 'the setting from .env');
    writeFileSync(join(dir, '.env'), 'GREETING=again');
    app.stdin.write(':');
    await type(app.stdin, 'reload');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('greeting again'), 'restarted with the new one');
  } finally {
    app.unmount();
  }
});

test('ctrl+f searches the log pane and the viewer, n N go between matches, esc clears; e shows only trouble', async () => {
  const dir = project({ procs: { talker: 'node talk.js' } }, {
    'talk.js': `for (let i = 1; i <= 5; i++) console.log('line ' + i + (i % 2 ? ' apple' : ' pear')); console.error('Error: the pear is bad'); setInterval(() => {}, 1000);`,
  });
  const app = start({ dir });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('Error: the pear is bad'), 'the log');
    app.stdin.write('\x06');
    await type(app.stdin, 'pear');
    await until(() => frame().includes('find pear▏ 3/3'), 'three matches, on the newest');
    assert.doesNotMatch(frame(), /> \/pear/, 'not typed into the prompt');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('find pear 3/3'), 'done typing');
    app.stdin.write('N');
    await until(() => frame().includes('find pear 2/3'), 'an older one');
    app.stdin.write('n');
    app.stdin.write('n');
    await until(() => frame().includes('find pear 1/3'), 'round to the oldest');
    app.stdin.write('\x06');
    await type(app.stdin, 'plum');
    await until(() => frame().includes('find plum▏ no match'), 'nothing found');
    app.stdin.write(KEYS.esc);
    await until(() => !frame().includes('find plum'), 'cleared');

    app.stdin.write('e');
    await until(() => frame().includes('trouble only') && !frame().includes('line 1 apple'), 'only the trouble');
    assert.match(frame(), /Error: the pear is bad/);
    app.stdin.write('e');
    await until(() => frame().includes('line 1 apple'), 'everything again');

    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('talker · node talk.js'), 'the viewer');
    app.stdin.write('/');
    await type(app.stdin, 'apple');
    await until(() => frame().includes('/apple▏ 3/3'), 'the viewer searched');
    app.stdin.write(KEYS.enter);
    app.stdin.write('e');
    await until(() => frame().includes('trouble only') && !frame().includes('line 3 apple'), 'the viewer\'s trouble');
    app.stdin.write(KEYS.esc);
    await until(() => !frame().includes('/apple') && frame().includes('talker · node talk.js'), 'esc clears the search first');
    app.stdin.write(KEYS.esc);
    await until(() => !frame().includes('esc close'), 'then closes');
    app.stdin.write('/');
    await until(() => frame().includes('enter run'), '/ opens the prompt in the Crew view');
  } finally {
    app.unmount();
  }
});

test('esc that clears a search is the search\'s alone, whichever handler Ink calls first', async () => {
  const dir = project({ procs: { talker: 'node talk.js' } }, {
    'talk.js': `console.log('a pear'); setInterval(() => {}, 1000);`,
  });
  const app = start({ dir });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('a pear'), 'the log');
    app.stdin.write('!');
    await type(app.stdin, 'node -e "console.log(4000+2)"');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('4002'), 'an activity line');
    // The uptimes and the port checks redraw App and the view in turn, which changes the order Ink
    // calls their key handlers in; esc at different moments meets both orders.
    for (const wait of [0, 700, 1300, 2100, 2600]) {
      app.stdin.write('\x06');
      await type(app.stdin, 'pear');
      app.stdin.write(KEYS.enter);
      await until(() => frame().includes('find pear 1/1'), 'a search');
      await new Promise((r) => setTimeout(r, wait));
      app.stdin.write(KEYS.esc);
      await until(() => !frame().includes('find pear'), 'the search cleared');
      assert.match(frame(), /4002/, `the activity lines stay (after ${wait} ms)`);
    }
  } finally {
    app.unmount();
  }
});

test('c clears a log, l and /save-log write it to a file, asking before writing over one', async () => {
  const dir = project({ procs: { talker: 'node talk.js' } }, { 'talk.js': `console.log('first words'); process.stdin.resume(); setTimeout(() => console.log('later words'), 1500); setInterval(() => {}, 1000);` });
  const app = start({ dir });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('first words'), 'the log');
    app.stdin.write('c');
    await until(() => frame().includes("Cleared talker's log") && !frame().includes('first words'), 'cleared');
    await until(() => frame().includes('later words'), 'what it says after');

    app.stdin.write('l');
    await until(() => frame().includes('/save-log talker talker.log'), 'the command in the prompt');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes("Wrote 1 line of talker's log to talker.log"), 'written');
    assert.equal(readFileSync(join(dir, 'talker.log'), 'utf8'), 'later words\n');

    app.stdin.write(':');
    await type(app.stdin, 'save-log talker talker.log');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('talker.log is there already. Write over it?'), 'the question');
    app.stdin.write(KEYS.esc);
    await until(() => !frame().includes('Write over it?'), 'answered no');
  } finally {
    app.unmount();
  }
});

test('a Procfile runs each process on its PORT, and /init writes it out as bosun.json', async () => {
  const port = await freePort();
  const dir = project({}, {
    Procfile: 'web: node server.js $PORT\nworker: node -e "console.log(\'worker port \' + process.env.PORT); setInterval(() => {}, 1000)"\n',
    '.env': `PORT=${port}`,
    'server.js': SERVER,
  });
  const { rmSync } = await import('node:fs');
  rmSync(join(dir, 'bosun.json'));
  const app = start({ dir });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('│  Procfile') && frame().includes(`:${port} ✓`), 'the web process answering on the PORT it was given');
    app.stdin.write('j');
    await until(() => frame().includes(`worker port ${port + 100}`), 'the next one on the PORT after');
    app.stdin.write(':');
    await type(app.stdin, 'init');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('│  bosun.json'), 'read from bosun.json now');
    const spec = JSON.parse(readFileSync(join(dir, 'bosun.json'), 'utf8'));
    assert.equal(spec.envFile, '.env');
    assert.equal(spec.procs.web.port, port);
  } finally {
    app.unmount();
  }
});

test('a crash, giving up and a long command notify; a stop doesn\'t, and the setting turns it off', async () => {
  const dir = project({ procs: { idle: 'node -e "setInterval(() => {}, 1000)"', broken: { run: 'node -e "console.error(\'Error: nope\'); process.exit(3)"', restart: 'on-failure' } } });
  const told = [];
  const app = start({ dir, config: { history: [], notifyAfter: 0 }, notify: (title, body) => told.push(`${title} | ${body}`), restartTimes: { first: 300, max: 300, stable: 60_000, quick: 60_000, giveUpAfter: 2 } });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => /broken\s+crashed\s+gave up/.test(frame()) && /idle\s+running/.test(frame()), 'the broken one given up on');
    assert.deepEqual(told, ['Bosun: broken crashed | Error: nope Restarting it.', 'Bosun: broken gave up | It ended 2 times in a row just after starting.']);
    app.stdin.write('s');
    await until(() => /idle\s+stopped/.test(frame()), 'idle stopped');
    app.stdin.write('!');
    await type(app.stdin, 'node -e "console.log(42)"');
    app.stdin.write(KEYS.enter);
    await until(() => told.length === 3, 'the command\'s end told');
    assert.equal(told[2], 'Bosun: node -e "console.log(42)" | 42');

    app.stdin.write(',');
    await until(() => /Notify\s+on/.test(frame()), 'the settings');
    for (let i = 0; i < 3; i++) app.stdin.write('j');
    await until(() => /❯ Notify\s+on/.test(frame()), 'on Notify');
    app.stdin.write(KEYS.enter);
    await until(() => /❯ Notify\s+off/.test(frame()), 'off');
    app.stdin.write(KEYS.esc);
    await until(() => !frame().includes('Accent colour'), 'the settings closed');
    app.stdin.write('!');
    await type(app.stdin, 'node -e "process.exit(1)"');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('exit'), 'the failed command');
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(told.length, 3, 'nothing said with the setting off');
  } finally {
    app.unmount();
  }
});

test('a pasted command line opens the prompt with it, not run; a single / opens it empty', async () => {
  const app = start();
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => /❯ ● api/.test(frame()), 'the crew');
    app.stdin.write('/stop api\r\n');
    await until(() => frame().includes('/stop api') && frame().includes('enter run'), 'the line in the prompt');
    assert.doesNotMatch(frame(), /There's no process/);
    app.stdin.write(KEYS.esc);
    await until(() => !frame().includes('enter run'), 'the prompt closed');
    app.stdin.write('rr');
    await new Promise((r) => setTimeout(r, 150));
    assert.doesNotMatch(frame(), /enter run/, 'other pastes are keys, not the prompt');
  } finally {
    app.unmount();
  }
});
