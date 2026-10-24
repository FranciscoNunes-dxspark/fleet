// What Splice does with the updater (the kit's update.js, tested in packages/kit): the note, the
// check kept in the config, installing in the background.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { removeTemp } from './temp.js';
import { App } from '../src/ui/App.jsx';

test('the app shows a newer release, keeps the check in the config, and can be told not to ask', async () => {
  const home = mkdtempSync(join(tmpdir(), 'splice-update-'));
  const prevHome = process.env.SPLICE_HOME;
  process.env.SPLICE_HOME = join(home, 'home');
  const notRepo = join(home, 'empty');
  const until = async (check, what) => {
    const end = Date.now() + 8000;
    while (!check()) {
      if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 40));
    }
  };
  let calls = 0;
  const checkUpdate = async (last) => {
    calls++;
    assert.equal(last, undefined);
    return { checked: { at: 5, latest: '9.9.9', url: 'https://example.com/latest' }, newer: true };
  };
  try {
    const app = render(React.createElement(App, { initialPath: notRepo, config: { recent: [], roots: [], history: [] }, checkUpdate }));
    try {
      await until(() => /Splice 9\.9\.9 is out/.test(app.lastFrame() ?? ''), 'the update note');
      await until(() => {
        try {
          return JSON.parse(readFileSync(join(home, 'home', 'config.json'), 'utf8')).lastUpdateCheck?.latest === '9.9.9';
        } catch {
          return false;
        }
      }, 'the check to be saved');
    } finally {
      app.unmount();
    }

    const off = render(React.createElement(App, { initialPath: notRepo, config: { recent: [], roots: [], history: [], checkForUpdates: false }, checkUpdate }));
    try {
      // Not a repository, so the first load ends in the Repos view (the note naming the path can be cut off).
      await until(() => /Repositories/.test(off.lastFrame() ?? ''), 'the first load');
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(calls, 1);
      assert.doesNotMatch(off.lastFrame(), /is out/);
    } finally {
      off.unmount();
    }
  } finally {
    if (prevHome === undefined) delete process.env.SPLICE_HOME;
    else process.env.SPLICE_HOME = prevHome;
    await removeTemp(home);
  }
});

test('the app installs a newer release in the background, says when it can\'t, and can be told only to tell', async () => {
  const home = mkdtempSync(join(tmpdir(), 'splice-autoupdate-'));
  const prevHome = process.env.SPLICE_HOME;
  process.env.SPLICE_HOME = join(home, 'home');
  const notRepo = join(home, 'empty');
  const until = async (check, what) => {
    const end = Date.now() + 8000;
    while (!check()) {
      if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 40));
    }
  };
  const checkUpdate = async () => ({ checked: { at: 5, latest: '9.9.9', url: 'https://example.com/latest' }, newer: true });
  const open = async (config, installUpdate, check) => {
    const app = render(React.createElement(App, { initialPath: notRepo, config: { recent: [], roots: [], history: [], ...config }, checkUpdate, installUpdate }));
    try {
      await until(() => check(app.lastFrame() ?? ''), 'the update note');
    } finally {
      app.unmount();
    }
  };
  try {
    const asked = [];
    await open({}, async (v) => asked.push(v), (f) => /Splice 9\.9\.9 is installed/.test(f));
    assert.deepEqual(asked, ['9.9.9']);

    await open({}, async () => {
      throw new Error("can't write to C:\\Program Files\\Splice\nmore detail");
    }, (f) => /couldn't be installed: can't write to/.test(f) && /example\.com\/latest/.test(f));

    let called = false;
    await open({ autoUpdate: false }, async () => {
      called = true;
    }, (f) => /Splice 9\.9\.9 is out/.test(f));
    assert.equal(called, false);
  } finally {
    if (prevHome === undefined) delete process.env.SPLICE_HOME;
    else process.env.SPLICE_HOME = prevHome;
    await removeTemp(home);
  }
});
