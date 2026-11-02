// The project's environment (.fleet/project.json): /env says and switches it, the header names it, a
// production one turns the frames red, and a push to the branch Splice's section names asks first there;
// and while Fleet records a runbook, the slash commands the prompt runs are kept, never git.
import { removeTemp } from './temp.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { theme } from '@fleet/kit/theme.js';
import { recordedLines, startRecording, stopRecording } from '@fleet/kit/recording.js';
import { readActivity } from '@fleet/kit/family.js';
import { App } from '../src/ui/App.jsx';

let base;
let familyHome;
let lastApp = null;

before(() => {
  base = mkdtempSync(join(tmpdir(), 'splice-env-'));
  process.env.SPLICE_HOME = join(base, 'home');
  // The kit's environments and its hook read the family's folder from here: never the real ~/.family.
  familyHome = join(base, 'family');
  process.env.FAMILY_HOME = familyHome;
});

after(() => removeTemp(base));

// No git identity is assumed (CI has none): each commit says who made it.
const WHO = ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false'];

function makeRepo(name) {
  const dir = join(base, name);
  const origin = join(base, `${name}.git`);
  mkdirSync(dir);
  execFileSync('git', ['init', '-q', '--bare', origin]);
  const g = (...args) => execFileSync('git', [...WHO, ...args], { cwd: dir, encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main');
  g('config', 'core.autocrlf', 'false');
  g('config', 'commit.gpgsign', 'false');
  mkdirSync(join(dir, '.fleet'));
  writeFileSync(join(dir, '.fleet', 'project.json'), JSON.stringify({ default: 'dev', environments: { dev: {}, prod: { prod: true, splice: { branch: 'main' } } } }));
  g('add', '.');
  g('commit', '-q', '-m', 'First');
  g('remote', 'add', 'origin', origin);
  g('push', '-q', '-u', 'origin', 'main');
  const remote = (...args) => execFileSync('git', ['--git-dir', origin, ...args], { encoding: 'utf8' }).trim();
  return { dir, g, remote };
}

async function until(check, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Timed out waiting for ${what}. Last frame:\n${lastApp?.lastFrame()}`);
}

test('/env says and switches the environment; in production a push to its branch asks first; the prompt\'s commands are recorded, not git', async () => {
  const { dir, g, remote } = makeRepo('shop');
  startRecording(dir, { home: familyHome });
  lastApp = render(React.createElement(App, { initialPath: dir, familyHome, moodEvery: 0, config: { recent: [], roots: [], history: [], riskBeforePush: false } }));
  const app = lastApp;
  const frame = () => app.lastFrame() ?? '';
  const command = async (text) => {
    app.stdin.write('/');
    await new Promise((r) => setTimeout(r, 50));
    for (const ch of text) app.stdin.write(ch);
    await new Promise((r) => setTimeout(r, 50));
    app.stdin.write('\r');
  };
  try {
    await until(() => frame().includes('First'), 'the graph');
    assert.match(frame().split('\n')[0], /│\s+dev/, 'the header names it');
    await command('env');
    await until(() => frame().includes('Environment: dev. /env prod switches every app.'), 'which one');

    await command('env prod');
    await until(() => frame().includes('Environment prod (production), for every app here. A push to main asks first.'), 'switched');
    await until(() => frame().split('\n')[0].includes('prod (production)') && theme.envProd === true, 'red frames');
    assert.ok(readActivity({ dir: familyHome }).some((e) => e.app === 'splice' && /to prod \(production\)$/.test(e.text)), 'in the activity');

    g('commit', '-q', '--allow-empty', '-m', 'Second');
    await until(() => frame().includes('Second'), 'the new commit');
    app.stdin.write('\x1bp');
    await until(() => frame().includes('prod is production. Push to main, the branch it deploys from?'), 'asked');
    app.stdin.write('\x1b');
    await until(() => !frame().includes('prod is production'), 'no');
    assert.equal(remote('log', '-1', '--format=%s', 'main'), 'First', 'not pushed');
    app.stdin.write('\x1bp');
    await until(() => frame().includes('prod is production. Push to main'), 'asked again');
    app.stdin.write('\r');
    await until(() => remote('log', '-1', '--format=%s', 'main') === 'Second', 'pushed', 20000);
    await until(() => readActivity({ dir: familyHome }).some((e) => e.app === 'splice' && /^pushed main/i.test(e.text)), 'the push done');

    // A branch the environment doesn't deploy from goes without a word.
    g('checkout', '-q', '-b', 'feature');
    g('commit', '-q', '--allow-empty', '-m', 'Third');
    await until(() => frame().includes('Third') && /⎇ feature/.test(frame().split('\n')[0]), 'the feature commit');
    app.stdin.write('\x1bp');
    await until(() => remote('branch', '--list', 'feature').includes('feature'), 'feature pushed', 20000);
    assert.ok(!frame().includes('prod is production'));

    await command('!status');
    await command('env nope');
    await until(() => frame().includes('No environment nope: dev, prod.'), 'no such one');
    assert.deepEqual(recordedLines({ home: familyHome }).map((l) => [l.app, l.line]), [['splice', '/env'], ['splice', '/env prod'], ['splice', '/env nope']]);
  } finally {
    stopRecording({ home: familyHome });
    app.unmount();
  }
  await until(() => theme.envProd === false, 'the frames back once it is gone');
});
