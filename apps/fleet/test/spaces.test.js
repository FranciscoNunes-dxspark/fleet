// A team's own tools as spaces (host.json's "spaces", spaces.js customSpaces), and one running in a host:
// examples/hello-tool.js, the protocol's smallest tool.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { IDS, customSpaces, launchCommand, spaceCommand } from '../src/spaces.js';
import { FAKE, PREFIX, startHost, stopAll, until } from './helpers.js';

after(stopAll);

const HELLO = fileURLToPath(new URL('../examples/hello-tool.js', import.meta.url));

test("host.json's spaces become tabs without a letter; one that isn't right is said and left out", () => {
  const { spaces, problems } = customSpaces([
    { id: 'deploys', title: 'Deploys', command: ['node', '/opt/deploys.js'], accent: '#123456' },
    { id: 'Bad Name', command: ['x'] },
    { id: 'splice', command: ['x'] },
    { id: 'nocommand' },
    { id: 'plain', command: ['tool', '--flag'] },
  ]);
  assert.deepEqual(spaces.map((s) => [s.id, s.title, s.letter, s.accent]), [
    ['deploys', 'Deploys', null, '#123456'],
    ['plain', 'plain', null, spaces[1].accent],
  ]);
  assert.match(spaces[1].accent, /^#[0-9a-f]{6}$/);
  assert.equal(problems.length, 3);
  assert.match(problems[0], /spaces\[1\]: "id"/);
  assert.match(problems[1], /already a space called splice/);
  assert.match(problems[2], /"command"/);
  assert.deepEqual(customSpaces(undefined), { spaces: [], problems: [] });
  assert.ok(IDS.includes('splice'));
});

test("a tool starts with its own command and the app's arguments; the family's apps as they always did", () => {
  const { spaces } = customSpaces([{ id: 'plain', command: ['tool', '--flag'] }]);
  const command = spaceCommand(spaces);
  assert.deepEqual(command('plain', ['x']), ['tool', ['--flag', 'x']]);
  assert.deepEqual(command('splice', ['a'], { compiled: true, execPath: '/bin/fleet' }), launchCommand('splice', ['a'], { compiled: true, execPath: '/bin/fleet' }));
});

test('the example tool runs as a space: drawn at its size, keys reaching it, reached by its number', async () => {
  const { spaces } = customSpaces([{ id: 'hello', title: 'Hello', command: [process.execPath, HELLO] }]);
  const all = [{ id: 'one', title: 'One', letter: 'o', accent: '#5fd787' }, ...spaces];
  // The tool by its own command; the test's own app (One) by the fake app the host tests use.
  const tool = spaceCommand(spaces);
  const command = (id, args) => (id === 'hello' ? tool(id, args) : [process.execPath, [FAKE, id, ...args]]);
  const { term, keys, done } = startHost({ spaces: all, command, columns: 70, rows: 14 });
  const { screen } = term;
  await until(() => screen.row(0) === 'one 70x13', 'the first app', { term });
  keys(`${PREFIX}2`);
  await until(() => screen.text().includes('70×13 is the room Fleet gives it'), 'the tool at its size', { term });
  assert.match(screen.row(-1), /2 Hello ●/);
  keys('ab');
  await until(() => screen.text().includes('Keys typed here: "ab"'), 'keys reaching the tool', { term });
  keys(`${PREFIX}q`);
  keys('y');
  await done;
});
