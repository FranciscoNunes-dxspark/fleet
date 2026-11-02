// /breaking: finding the lines that import a package, what Claude is asked, and the whole of it over the demo.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NOT_INSTALLED } from '@fleet/kit/claude-cli.js';
import { breakingInput, breakingPrompt, findUsages, usageLines } from '../src/breaking.js';
import { createBilge } from '../src/provider.js';
import { demoBilge } from '../src/demo.js';
import { nuspecRepository, repositoryUrl } from '../src/registry.js';
import { KEYS, start, tempHome, type, until } from './helpers.js';

let cleanup;
beforeEach(() => {
  cleanup = tempHome();
});
afterEach(() => cleanup());

const shows = (app, text) => () => app.lastFrame().includes(text);
const npm = { ecosystem: 'npm', name: 'express', version: '4.17.1' };

test("a package's imports: npm's import, require and import(), a subpath too; NuGet's using, open and Imports", () => {
  const js = ["import express from 'express';", "const { Router } = require('express');", "const lazy = await import(\"express/lib/router\");", "import 'express-session';", "// express is great", "const x = require('expressive');"].join('\n');
  assert.deepEqual(usageLines(js, npm).map((u) => u.line), [1, 2, 3]);
  const scoped = { ecosystem: 'npm', name: '@azure/identity', version: '3.0.0' };
  assert.equal(usageLines("import { DefaultAzureCredential } from '@azure/identity';", scoped).length, 1);
  const nuget = { ecosystem: 'NuGet', name: 'Newtonsoft.Json', version: '12.0.1' };
  const cs = ['using System;', 'using Newtonsoft.Json;', 'using Newtonsoft.Json.Linq;', 'global using static Newtonsoft.Json.JsonConvert;', 'using Json = Newtonsoft.Json;', 'using Newtonsoft.JsonX;', 'open Newtonsoft.Json', 'Imports Newtonsoft.Json'].join('\n');
  assert.deepEqual(usageLines(cs, nuget).map((u) => u.line), [2, 3, 4, 5, 7, 8]);
});

test('the project searched for them: source files only, node_modules and hidden folders left alone, bounded', () => {
  const root = mkdtempSync(join(tmpdir(), 'bilge-uses-'));
  try {
    const put = (path, text) => {
      mkdirSync(join(root, ...path.split('/').slice(0, -1)), { recursive: true });
      writeFileSync(join(root, ...path.split('/')), text);
    };
    put('src/server.ts', "import express from 'express';\nexpress();\n");
    put('src/routes/a.mjs', "import { Router } from 'express';\n");
    put('README.md', "import express from 'express';\n");
    put('node_modules/x/index.js', "require('express');\n");
    put('.cache/y.js', "require('express');\n");
    assert.deepEqual(findUsages(root, npm), [{ path: 'src/routes/a.mjs', line: 1, text: "import { Router } from 'express';" }, { path: 'src/server.ts', line: 1, text: "import express from 'express';" }]);
    assert.equal(findUsages(root, npm, { maxLines: 1 }).length, 1);
    assert.deepEqual(findUsages(root, { ecosystem: 'Debian:12', name: 'openssl', version: '3' }), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('what Claude is asked: the package, both versions, where to read about it, and the lines that use it', () => {
  const prompt = breakingPrompt(npm, '4.17.1', '5.1.0', { page: 'https://www.npmjs.com/package/express/v/4.17.1', repository: 'https://github.com/expressjs/express' });
  assert.match(prompt, /npm package express at 4\.17\.1\. Its newest version is 5\.1\.0, a major version up/);
  assert.match(prompt, /Its repository: https:\/\/github\.com\/expressjs\/express/);
  assert.match(breakingInput(npm, [{ path: 'src/a.js', line: 3, text: "require('express')" }]), /src\/a\.js:3: require\('express'\)/);
  assert.match(breakingInput(npm, []), /No line of this project's source imports express/);
  assert.equal(repositoryUrl('git+https://github.com/expressjs/express.git'), 'https://github.com/expressjs/express');
  assert.equal(repositoryUrl('github:lodash/lodash'), 'https://github.com/lodash/lodash');
  assert.equal(repositoryUrl('not a url'), null);
  assert.equal(nuspecRepository('<package><metadata><repository type="git" url="https://github.com/JamesNK/Newtonsoft.Json.git" /></metadata></package>'), 'https://github.com/JamesNK/Newtonsoft.Json');
});

test("the provider asks Claude through the CLI, read-only but for fetching a page; without Claude it says so", async () => {
  const seen = [];
  const execImpl = (cmd, args, opts, done) => {
    seen.push([cmd, args]);
    setImmediate(() => done(null, 'An answer.\n', ''));
    return { stdin: { on() {}, end() {} } };
  };
  assert.equal(await createBilge({ execImpl }).claude('What breaks?', { input: 'lines' }), 'An answer.');
  const args = seen[0][1];
  assert.equal(seen[0][0], 'claude');
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Grep,Glob,WebFetch');
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'WebFetch');
  const missing = (cmd, a, o, done) => {
    setImmediate(() => done(Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' })));
    return { stdin: { on() {}, end() {} } };
  };
  await assert.rejects(createBilge({ execImpl: missing }).claude('x'), (e) => e.message === NOT_INSTALLED);
});

test('/breaking on a major bump asks Claude with the lines that import it and shows the answer; a minor one says it isn\'t', async () => {
  const app = start();
  await until(shows(app, 'minimist@1.2.5'), 'the findings');
  await type(app.stdin, '/breaking express');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'what breaks here (Claude)'), 'the answer');
  assert.match(app.lastFrame(), /express 4\.17\.1 → 5\.1\.0/);
  assert.match(app.lastFrame(), /Moving express from 4\.17\.1 to 5\.1\.0 is a small job here/);
  assert.match(app.lastFrame(), /Lines that import it: 2 \(src\/server\.js, src\/routes\/orders\.js\)/);
  const { prompt, input } = app.provider.state.asked;
  assert.match(prompt, /Its repository: https:\/\/github\.com\/expressjs\/express/);
  assert.match(input, /src\/server\.js:1: const express = require\('express'\);/);
  assert.ok(app.provider.state.calls.some((c) => c[0] === 'latest'), 'the newest version asked first');
  app.stdin.write(KEYS.esc);
  await until(() => !app.lastFrame().includes('what breaks here'), 'the view again');
  await type(app.stdin, '/breaking lodash');
  app.stdin.write(KEYS.enter);
  await until(shows(app, "lodash 4.17.20 → 4.17.21 isn't a major version"), 'the refusal');
  assert.equal(app.provider.state.calls.filter((c) => c[0] === 'claude').length, 1);
  app.unmount();
});

test('/breaking without Claude installed says so', async () => {
  const provider = demoBilge();
  provider.claude = async () => {
    throw new Error(NOT_INSTALLED);
  };
  const app = start({ provider });
  await until(shows(app, 'minimist@1.2.5'), 'the findings');
  await type(app.stdin, '/breaking express');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'Claude Code (claude) is not installed'), 'the error');
  app.unmount();
});
