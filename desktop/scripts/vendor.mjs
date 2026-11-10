// Puts xterm.js and its add-ons (fit, WebGL, links, images) in ui/vendor, from npm, at the versions pinned here.
// The desktop app isn't one of the repository's npm workspaces (it's built with cargo, not Bun, and
// released by hand for now), so it has no node_modules of its own: `npm pack` fetches the packages and
// their files are copied out.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PACKAGES = {
  '@xterm/xterm@5.5.0': { 'lib/xterm.js': 'xterm.js', 'css/xterm.css': 'xterm.css' },
  '@xterm/addon-fit@0.10.0': { 'lib/addon-fit.js': 'addon-fit.js' },
  '@xterm/addon-webgl@0.18.0': { 'lib/addon-webgl.js': 'addon-webgl.js' },
  '@xterm/addon-web-links@0.11.0': { 'lib/addon-web-links.js': 'addon-web-links.js' },
  '@xterm/addon-image@0.8.0': { 'lib/addon-image.js': 'addon-image.js' },
};

const out = new URL('../ui/vendor/', import.meta.url);
mkdirSync(out, { recursive: true });
const work = mkdtempSync(join(tmpdir(), 'fleet-desktop-'));
try {
  for (const [spec, files] of Object.entries(PACKAGES)) {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const tarball = execFileSync(npm, ['pack', spec, '--silent', '--pack-destination', work], { encoding: 'utf8', shell: process.platform === 'win32' }).trim().split('\n').pop();
    const name = spec.replace(/[@/]/g, '_');
    const dir = join(work, name);
    mkdirSync(dir);
    // Relative paths, from the work folder: Git for Windows' tar takes "C:\…" for a host called C.
    execFileSync('tar', ['-xzf', tarball, '-C', name], { cwd: work });
    for (const [from, to] of Object.entries(files)) copyFileSync(join(dir, 'package', from), new URL(to, out));
    console.log(`${spec}: ${Object.values(files).join(', ')}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
