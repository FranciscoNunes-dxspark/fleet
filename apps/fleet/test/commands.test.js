// The desktop window's palette lists every app's slash commands from src/commands.json, made by
// scripts/commands.js from each app's own table: the file must say what the tables say.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FILE, allCommands } from '../scripts/commands.js';
import { SPACES } from '../src/spaces.js';

test('commands.json is every app\'s commands as its own table has them (node scripts/commands.js remakes it)', async () => {
  const kept = JSON.parse(readFileSync(FILE, 'utf8'));
  assert.deepEqual(Object.keys(kept), SPACES.map((s) => s.id));
  assert.deepEqual(kept, await allCommands(), 'commands.json is behind an app\'s commands: run node scripts/commands.js');
  assert.ok(kept.splice.some((c) => c.name === 'commit' && c.desc));
});
