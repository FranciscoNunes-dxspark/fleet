import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** Opens a URL in the default browser. */
export function openUrl(url) {
  const [cmd, args] =
    process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  execFile(cmd, args, { windowsHide: true }, () => {});
}

/** Keel's version: baked into the standalone executables by scripts/build-cli.js, else from package.json. */
export const VERSION =
  process.env.KEEL_VERSION ?? JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

/** Whether this is a downloaded executable (scripts/build-cli.js), which updates itself, rather than a checkout. */
export const COMPILED = process.env.KEEL_VERSION !== undefined;
