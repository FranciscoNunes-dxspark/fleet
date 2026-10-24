import { execFile } from 'node:child_process';

/** Opens a URL in the default browser. */
export function openUrl(url) {
  const [cmd, args] =
    process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  execFile(cmd, args, { windowsHide: true }, () => {});
}

// Keel's version (baked into the standalone executables by the kit's scripts/build.js, else from
// package.json), and whether this is a downloaded executable, which updates itself, rather than a checkout.
export { VERSION, COMPILED } from './app.js';
