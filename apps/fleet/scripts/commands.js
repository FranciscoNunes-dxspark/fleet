// Writes src/commands.json: every app's slash commands (name, args, desc) for the desktop window's
// palette, read from each app's own table (src/commands.js; Keel's cli/commands.js). Each table is read
// in a process of that app's (its app.js first), since an app's modules take the process to be that
// app. Run it after a change to any app's commands: `node scripts/commands.js` (test/commands.test.js
// says when the file is behind).
import { execFile } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SPACES } from '../src/spaces.js';

const APPS = fileURLToPath(new URL('../../', import.meta.url));

/** Where app `id` keeps its app.js and its commands table. */
function files(id) {
  const dir = existsSync(`${APPS}${id}/cli/commands.js`) ? 'cli' : 'src';
  return { cwd: `${APPS}${id}`, app: `./${dir}/app.js`, commands: pathToFileURL(`${APPS}${id}/${dir}/commands.js`).href };
}

/** App `id`'s commands: [{ name, args, desc }], from its own table in a process of its own. */
export function readCommands(id) {
  const { cwd, app, commands } = files(id);
  // Helm has no slash commands (its keys are F5, F8 and the like).
  if (!existsSync(fileURLToPath(commands))) return Promise.resolve([]);
  const code = `const { COMMANDS } = await import(${JSON.stringify(commands)}); process.stdout.write(JSON.stringify(COMMANDS.map((c) => ({ name: c.name, args: c.args ?? '', desc: c.desc ?? '' }))));`;
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['--import', '@fleet/kit/register.js', '--import', app, '--input-type=module', '-e', code], { cwd, maxBuffer: 8 << 20, env: { ...process.env, FLEET_HOSTED: '' } }, (err, out, errOut) =>
      err ? reject(new Error(`${id}: ${errOut || err.message}`)) : resolve(JSON.parse(out)),
    );
  });
}

/** Every space's commands, four apps at a time: { id: [...] }. */
export async function allCommands() {
  const out = {};
  const queue = SPACES.map((s) => s.id);
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (queue.length) {
        const id = queue.shift();
        out[id] = await readCommands(id);
      }
    }),
  );
  return Object.fromEntries(SPACES.map((s) => [s.id, out[s.id]]));
}

export const FILE = new URL('../src/commands.json', import.meta.url);

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const all = await allCommands();
  writeFileSync(FILE, `${JSON.stringify(all, null, 1)}\n`);
  console.log(Object.entries(all).map(([id, c]) => `${id} ${c.length}`).join(', '));
}
