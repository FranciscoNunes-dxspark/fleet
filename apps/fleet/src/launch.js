// Starting an app for the host, and stopping it with everything it started. An app gets pipes, not a
// terminal: stdin and stdout for keys and drawing, stderr kept to show if it fails, and fd 3 for the
// host's messages (the kit's hosted.js). Off Windows it leads a process group of its own, so killing
// it kills what it started; on Windows taskkill /T does that (as the kit's run.js does).
import { spawn, spawnSync } from 'node:child_process';
import { HOSTED_VARIABLE } from '@fleet/kit/hosted.js';
import { launchCommand } from './spaces.js';

/** FORCE_COLOR's level for a terminal of `depth` bits (getColorDepth's answer). */
export const colorLevel = (depth) => (depth >= 24 ? '3' : depth >= 8 ? '2' : depth >= 4 ? '1' : '0');

/**
 * The environment an app starts with: the host's, plus hosted mode and its size. The app's stdout is a
 * pipe, where colour libraries would turn colour off, so the terminal's colour depth goes with it as
 * FORCE_COLOR (unless NO_COLOR or FORCE_COLOR says otherwise already).
 */
export function appEnv({ env = process.env, columns, rows, depth = 24 }) {
  const out = { ...env, [HOSTED_VARIABLE]: '1', FLEET_COLUMNS: String(columns), FLEET_ROWS: String(rows) };
  if (out.FORCE_COLOR == null && out.NO_COLOR == null) out.FORCE_COLOR = colorLevel(depth);
  return out;
}

/** Kills process `pid` and what it started: gently first (SIGTERM), or at once with `force`. */
export function killTree(pid, { force = false, platform = process.platform } = {}) {
  if (!pid) return;
  if (platform === 'win32') {
    // A console program with no window of its own ignores taskkill's polite request: always /F.
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    return;
  }
  for (const target of force ? [-pid, pid] : [pid]) {
    try {
      process.kill(target, force ? 'SIGKILL' : 'SIGTERM');
    } catch {
      // Gone already.
    }
  }
}

/**
 * A `spawn` for Host: starts app `id` with `args` at `columns`×`rows` in `cwd`, and returns it as the
 * host uses it ({ pid, stdin, stdout, stderr, control, on, kill(force) }).
 */
export function appSpawner({ compiled, cwd = process.cwd(), env = process.env, depth = 24, command = launchCommand } = {}) {
  return (id, { columns, rows, args = [] }) => {
    const [file, argv] = command(id, args, { compiled });
    const child = spawn(file, argv, {
      cwd,
      env: appEnv({ env, columns, rows, depth }),
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    return {
      pid: child.pid,
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      control: child.stdio[3],
      on: (event, fn) => child.on(event, fn),
      kill: (force) => killTree(child.pid, { force }),
    };
  };
}
