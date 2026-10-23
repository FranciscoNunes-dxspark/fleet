// The terminal app's first run (cli/setup.js): what counts as an organization address, how the
// answers land in .env, and the questions themselves, typed through a stream.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { parseEnv } from 'node:util';
import { firstRunSetup, orgUrlFrom, withSettings } from '../cli/setup.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-setup-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('organization addresses: a name, a full address, an old or server one', () => {
  assert.equal(orgUrlFrom('contoso'), 'https://dev.azure.com/contoso');
  assert.equal(orgUrlFrom(' https://dev.azure.com/contoso/Web/_git/shop/ '), 'https://dev.azure.com/contoso');
  assert.equal(orgUrlFrom('dev.azure.com/contoso'), 'https://dev.azure.com/contoso');
  assert.equal(orgUrlFrom('https://Contoso.visualstudio.com/Web'), 'https://contoso.visualstudio.com');
  assert.equal(orgUrlFrom('https://tfs.example.com/tfs/DefaultCollection'), 'https://tfs.example.com/tfs/DefaultCollection');
  for (const bad of ['', 'http://dev.azure.com/contoso', 'https://dev.azure.com/', 'https://me:pw@dev.azure.com/x', 'not an address']) assert.equal(orgUrlFrom(bad), null, bad);
});

test('saved settings replace the empty lines a copied .env.example has, and keep the rest', () => {
  assert.equal(withSettings('', ['AZDO_ORG_URL=https://dev.azure.com/a']), '# Saved by keel on first run.\nAZDO_ORG_URL=https://dev.azure.com/a\n');
  const example = '# Azure DevOps\nAZDO_ORG_URL=\nAZDO_PAT=\n# AZDO_AUTH=az\nAZDO_PROJECTS=Web';
  assert.equal(
    withSettings(example, ['AZDO_ORG_URL=https://dev.azure.com/a', 'AZDO_AUTH=az']),
    '# Azure DevOps\nAZDO_ORG_URL=https://dev.azure.com/a\nAZDO_PAT=\n# AZDO_AUTH=az\nAZDO_PROJECTS=Web\n\n# Saved by keel on first run.\nAZDO_AUTH=az\n',
  );
});

/** Runs the questions with these answers typed in, as a non-terminal stream. */
async function answer(lines, envFile) {
  const input = new PassThrough();
  const output = new PassThrough();
  let shown = '';
  const queue = [...lines];
  // Each answer is typed once its question shows (they all end in "›").
  output.on('data', (d) => {
    shown += d;
    if (String(d).includes('› ') && queue.length) setImmediate(() => input.write(`${queue.shift()}\n`));
  });
  const env = {};
  const result = await firstRunSetup({ envFile, env, input, output });
  return { result, env, shown };
}

test('first run with the Azure CLI: the organization and AZDO_AUTH=az are saved, no token', async () => {
  const envFile = path.join(dir, 'az', '.env'); // the folder doesn't exist yet, as ~/.keel on a first run
  const { result, env, shown } = await answer(['2', 'nope nope', 'contoso', ''], envFile);
  assert.equal(result, 'saved');
  assert.deepEqual(env, { AZDO_ORG_URL: 'https://dev.azure.com/contoso', AZDO_AUTH: 'az' });
  assert.match(shown, /doesn't look like an organization address/);
  assert.equal(fs.readFileSync(envFile, 'utf8'), '# Saved by keel on first run.\nAZDO_ORG_URL=https://dev.azure.com/contoso\nAZDO_AUTH=az\n');
});

test('first run with a token: it is saved for the next start', async () => {
  const envFile = path.join(dir, 'pat.env');
  const { env } = await answer(['2', 'https://dev.azure.com/contoso', '2', 'abc123token'], envFile);
  assert.equal(env.AZDO_PAT, 'abc123token');
  // What the next start reads, as process.loadEnvFile does.
  assert.equal(parseEnv(fs.readFileSync(envFile, 'utf8')).AZDO_PAT, 'abc123token');
});

test('in a terminal the token is typed unseen: dots, backspace works, and it never reaches the screen', async () => {
  const envFile = path.join(dir, 'tty.env');
  const input = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode(on) { this.isRaw = on; return this; } });
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 120, rows: 40 });
  let shown = '';
  const keys = ['2\r', 'contoso\r', '2\r', 'secretX\u007f\r'];
  output.on('data', (d) => {
    shown += d;
    if (String(d).includes('› ') && keys.length) setImmediate(() => input.write(keys.shift()));
  });
  const env = {};
  assert.equal(await firstRunSetup({ envFile, env, input, output }), 'saved');
  assert.equal(env.AZDO_PAT, 'secret');
  assert.ok(!shown.includes('secret'), 'the token was echoed');
  assert.match(shown, /••••••/);
  assert.equal(input.isRaw, false);
});

test("first run with your team's Keel: its address is saved, and signing in comes next", async () => {
  const envFile = path.join(dir, 'keel.env');
  const { result, env, shown } = await answer(['', 'not a keel', 'keel.example.com/inbox'], envFile);
  assert.equal(result, 'keel');
  assert.deepEqual(env, { KEEL_SERVER: 'https://keel.example.com' });
  assert.match(shown, /doesn't look like a Keel address/);
  assert.equal(parseEnv(fs.readFileSync(envFile, 'utf8')).KEEL_SERVER, 'https://keel.example.com');
  // Left empty, it asks again (there is no default unless KEEL_DEFAULT_SERVER is set).
  const again = await answer(['1', '', 'keel.example.com'], path.join(dir, 'keel-default.env'));
  assert.deepEqual(again.env, { KEEL_SERVER: 'https://keel.example.com' });
  assert.match(again.shown, /doesn't look like a Keel address/);
});

test('first run choosing the demo: nothing saved', async () => {
  const envFile = path.join(dir, 'demo.env');
  const { result, env } = await answer(['3'], envFile);
  assert.equal(result, 'demo');
  assert.deepEqual(env, {});
  assert.equal(fs.existsSync(envFile), false);
});
