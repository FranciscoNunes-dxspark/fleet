// The project's own sources (local.js): .env parsing and writing, appsettings flattened as .NET reads it,
// user secrets found through the .csproj, Hail's env files, and a folder read whole.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addToDotenv, createLocal, dotenvValue, envKey, flatten, isExample, parseDotenv, readLocal, userSecretsId, userSecretsPath } from '../src/local.js';
import { demoLocal } from '../src/demo.js';

test('a .env file is read as dotenv reads it', () => {
  const text = [
    '# a comment',
    'PLAIN=value',
    'export EXPORTED=yes',
    'SPACED = around  ',
    'COMMENTED=abc # not this',
    "SINGLE='keeps # and \\n'",
    'DOUBLE="line\\nnext \\"quoted\\""',
    'MULTI="first',
    'second"',
    'EMPTY=',
    'HASH=a#b',
    '',
    'not a setting',
  ].join('\r\n');
  const got = Object.fromEntries(parseDotenv(text).map((e) => [e.key, e.value]));
  assert.deepEqual(got, {
    PLAIN: 'value',
    EXPORTED: 'yes',
    SPACED: 'around',
    COMMENTED: 'abc',
    SINGLE: 'keeps # and \\n',
    DOUBLE: 'line\nnext "quoted"',
    MULTI: 'first\nsecond',
    EMPTY: '',
    HASH: 'a#b',
  });
  assert.equal(parseDotenv(text).find((e) => e.key === 'EMPTY').line, 10);
  assert.deepEqual(parseDotenv('\uFEFFA=1'), [{ key: 'A', value: '1', line: 1 }]);
});

test('a value written to .env reads back the same', () => {
  for (const v of ['plain', 'with space', 'quote"d', 'back\\slash', 'two\nlines', 'Server=x;Password=p#1', '']) {
    const text = addToDotenv('A=1\n', 'B', v);
    assert.equal(parseDotenv(text).find((e) => e.key === 'B').value, v, v);
  }
  assert.equal(dotenvValue('https://x.example/a?b=c'), 'https://x.example/a?b=c');
  assert.equal(addToDotenv('A=1', 'B', 'x'), 'A=1\nB=x\n');
  assert.equal(addToDotenv('A=1\r\n', 'B', 'x'), 'A=1\r\nB=x\r\n');
  assert.equal(addToDotenv('', 'B', 'x'), 'B=x\n');
  assert.equal(envKey('ConnectionStrings:Default'), 'ConnectionStrings__Default');
  assert.ok(isExample('.env.example') && isExample('.env.sample') && !isExample('.env.local'));
});

test('appsettings are flattened with : as .NET reads them', () => {
  assert.deepEqual(flatten({ Logging: { LogLevel: { Default: 'Information' } }, Hosts: ['a', 'b'], Flag: true, Count: 3, Nothing: null, Empty: {} }), [
    { key: 'Logging:LogLevel:Default', value: 'Information' },
    { key: 'Hosts:0', value: 'a' },
    { key: 'Hosts:1', value: 'b' },
    { key: 'Flag', value: 'true' },
    { key: 'Count', value: '3' },
    { key: 'Nothing', value: '' },
    { key: 'Empty', value: '' },
  ]);
});

test('user secrets are found through the .csproj, where .NET keeps them on each system', () => {
  assert.equal(userSecretsId('<Project><PropertyGroup><UserSecretsId> abc-123 </UserSecretsId></PropertyGroup></Project>'), 'abc-123');
  assert.equal(userSecretsId('<Project/>'), null);
  assert.equal(userSecretsPath('abc', { platform: 'linux', home: '/home/me' }).replace(/\\/g, '/'), '/home/me/.microsoft/usersecrets/abc/secrets.json');
  assert.match(userSecretsPath('abc', { platform: 'win32', env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, home: 'C:\\Users\\me' }).replace(/\\/g, '/'), /Roaming\/Microsoft\/UserSecrets\/abc\/secrets\.json$/);
});

test('a folder is read whole: .env files, appsettings, user secrets and Hail env files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'locker-local-'));
  const home = join(dir, 'home');
  try {
    writeFileSync(join(dir, '.env'), 'A=1\nDb__Password=dev\n');
    writeFileSync(join(dir, '.env.example'), 'A=\nB=\n');
    writeFileSync(join(dir, 'appsettings.json'), '\uFEFF{"A":"1","Db":{"Password":"x"}}');
    writeFileSync(join(dir, 'appsettings.Development.json'), '{"A":"2"}');
    writeFileSync(join(dir, 'appsettings.Broken.json'), '{ nope');
    writeFileSync(join(dir, 'http-client.env.json'), '{"dev":{"host":"localhost","n":3},"bad":1}');
    mkdirSync(join(dir, 'src', 'Api'), { recursive: true });
    writeFileSync(join(dir, 'src', 'Api', 'Api.csproj'), '<Project><PropertyGroup><UserSecretsId>api-1</UserSecretsId></PropertyGroup></Project>');
    mkdirSync(join(home, '.microsoft', 'usersecrets', 'api-1'), { recursive: true });
    writeFileSync(join(home, '.microsoft', 'usersecrets', 'api-1', 'secrets.json'), '{"Db:Password":"from-secrets"}');
    const sources = readLocal(dir, { platform: 'linux', home });
    assert.deepEqual(sources.map((s) => s.label), ['.env', '.env.example', 'appsettings.json', 'appsettings.Broken.json', 'appsettings.Development.json', 'user secrets (Api)', 'http-client:dev']);
    const by = Object.fromEntries(sources.map((s) => [s.label, s]));
    assert.equal(by['.env'].writable, true);
    assert.equal(by['.env.example'].writable, false);
    assert.equal(by['.env.example'].example, true);
    assert.match(by['appsettings.Broken.json'].problem, /not JSON/);
    assert.deepEqual(by['user secrets (Api)'].entries, [{ key: 'Db:Password', value: 'from-secrets' }]);
    assert.deepEqual(by['http-client:dev'].entries, [{ key: 'host', value: 'localhost' }, { key: 'n', value: '3' }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createLocal adds a key to .env, making the file when it is not there, and nothing else', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'locker-local-'));
  try {
    const local = createLocal({ dir });
    await local.addToEnv('.env', 'Db__Password', 'p a"ss');
    await local.addToEnv(join(dir, '.env'), 'B', '2');
    assert.equal(readFileSync(join(dir, '.env'), 'utf8'), 'Db__Password="p a\\"ss"\nB=2\n');
    await assert.rejects(local.addToEnv('appsettings.json', 'A', '1'), /isn't a \.env file/);
    assert.equal((await local.sources())[0].entries[0].value, 'p a"ss');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the demo folder has the same shape', async () => {
  const local = demoLocal();
  const sources = await local.sources();
  assert.ok(sources.some((s) => s.kind === 'usersecrets'));
  await local.addToEnv('.env', 'Stripe__ApiKey', 'x');
  assert.deepEqual(local.state.calls, [['addToEnv', '.env', 'Stripe__ApiKey']]);
  assert.match(local.state.files['.env'], /Stripe__ApiKey=x\n$/);
});
