// Opening Sonar, Keel's sibling Azure console, on a production monitor: the app behind its address,
// at its problems. Sonar is another terminal app, so it can't share this terminal: in Windows Terminal
// it opens in a new tab; anywhere else the command is copied for you to run.
import { spawn } from 'node:child_process';
import { copyToClipboard } from './clipboard.js';

/** Sonar's arguments for monitor `m`: its address, its Application Insights when it has one, and Problems. */
export function sonarArgs(m) {
  return ['--url', m.url, ...(m.appInsightsAppId ? ['--insights', m.appInsightsAppId] : []), '--problems'];
}

const quote = (a) => (/^[\w./:@=-]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`);

/** The command line for `args`, to run in a terminal. */
export const sonarCommand = (args) => ['sonar', ...args].map(quote).join(' ');

/**
 * Opens Sonar with `args`: { how: 'tab' } when it started in a new Windows Terminal tab, else the
 * command is copied ({ how: 'copied', command }). `env` and `spawnImpl` stand in for the real ones in tests.
 */
export async function openSonar(args, { env = process.env, spawnImpl = spawn, copy = copyToClipboard } = {}) {
  if (env.WT_SESSION) {
    try {
      await new Promise((resolve, reject) => {
        const child = spawnImpl('wt', ['-w', '0', 'new-tab', 'sonar', ...args], { detached: true, stdio: 'ignore', windowsHide: true });
        child.on('error', reject);
        child.on('spawn', () => (child.unref(), resolve()));
      });
      return { how: 'tab' };
    } catch {
      // No wt on the PATH after all: copy it instead.
    }
  }
  const command = sonarCommand(args);
  await copy(command);
  return { how: 'copied', command };
}
