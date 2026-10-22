// Opening a link in the browser, through what the system has for it.
import { spawn } from 'node:child_process';

/** Opens `url` in the default browser; resolves once it's handed over. */
export function openUrl(url) {
  const [cmd, args] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', reject);
    child.on('spawn', () => (child.unref(), resolve()));
  });
}
