// A real app in hosted mode: Hail, which starts fast, run by the host from this checkout as `fleet hail`
// runs it, beside a fake app to switch to and back from.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchCommand } from '../src/spaces.js';
import { FAKE, PREFIX, alive, quietEnv, startHost, stopAll, until } from './helpers.js';

const dir = mkdtempSync(join(tmpdir(), 'fleet-hail-'));
after(() => {
  stopAll();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('Hail in hosted mode draws above the bar, takes keys, and is drawn again after a switch', { timeout: 90_000 }, async () => {
  writeFileSync(join(dir, 'api.http'), '### Ping\nGET http://127.0.0.1:9/ping\n');
  const spaces = [
    { id: 'hail', title: 'Hail', letter: 'h', accent: '#e8445a' },
    { id: 'two', title: 'Two', letter: 'w', accent: '#5fafff' },
  ];
  const command = (id, args) => (id === 'hail' ? launchCommand('hail', args) : [process.execPath, [FAKE, id, ...args]]);
  const env = quietEnv({ HAIL_HOME: join(dir, 'home'), FAMILY_HOME: join(dir, 'family') });
  const { host, term, keys, done } = startHost({ spaces, command, env, cwd: dir, columns: 100, rows: 30 });
  const { screen } = term;
  const shown = (text) => term.text().includes(text);
  await until(() => shown('Welcome to Hail') && shown('1 request in api.http'), 'Hail', { term, ms: 60_000 });
  assert.match(screen.row(-1), /^ 1 Hail HTTP ● {2}2 Two ○/);
  // Its frame stays above the bar: the row above it is Hail's.
  assert.ok(screen.row(-2).length < 100);
  keys('?');
  await until(() => shown('Keyboard shortcuts'), "Hail's help", { term, ms: 20_000 });

  keys(`${PREFIX}w`);
  await until(() => screen.row(0) === 'two 100x29', 'the other app', { term, ms: 20_000 });
  assert.ok(!shown('Keyboard shortcuts'));
  keys(`${PREFIX}h`);
  await until(() => shown('Keyboard shortcuts') && shown('Welcome to Hail'), 'Hail drawn again', { term, ms: 20_000 });
  assert.match(screen.row(-1), /^ 1 Hail HTTP ● {2}2 Two ●/);

  // Split, Ink's frames drawn through the host's virtual terminal land in Hail's own columns.
  keys('\x1b');
  keys(`${PREFIX}|`);
  const left = () => Array.from({ length: 29 }, (_, y) => screen.row(y).slice(0, 49)).join('\n');
  await until(() => screen.row(0).slice(50) === 'two 50x29' && left().includes('Hail') && left().includes('api.http'), 'Hail in the left pane', { term, ms: 20_000 });
  assert.ok(Array.from({ length: 29 }, (_, y) => screen.row(y)[49]).every((c) => c === '│'), 'the divider whole');
  keys(`${PREFIX}x`);
  await until(() => shown('api.http') && !shown('two 50x29') && screen.row(2).length > 90, 'Hail whole again', { term, ms: 20_000 });

  const pid = host.space('hail').child.pid;
  keys(`${PREFIX}q`);
  await until(() => screen.row(-1).includes('Quit Fleet?'), 'the question', { term });
  keys('y');
  await done;
  await until(() => !alive(pid), 'Hail gone', { ms: 20_000 });
});
