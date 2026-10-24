// What the host keeps between starts, in ~/.fleet/host.json (FLEET_HOME moves the folder, as tests
// do): the space used last, which `fleet` alone opens, and the last update check.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const fleetHome = (env = process.env) => env.FLEET_HOME || join(homedir(), '.fleet');

/** The kept state, {} when there's none or it can't be read. */
export function loadState(env = process.env) {
  try {
    const value = JSON.parse(readFileSync(join(fleetHome(env), 'host.json'), 'utf8'));
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

/** Merges `patch` into the kept state; quietly does nothing when the folder can't be written. */
export function saveState(patch, env = process.env) {
  try {
    const dir = fleetHome(env);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'host.json');
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ ...loadState(env), ...patch }, null, 2)}\n`);
    renameSync(tmp, file);
  } catch {
    // The state is a convenience: the host works without it.
  }
}
