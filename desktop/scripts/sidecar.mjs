// Puts Fleet's own executable where the Tauri bundle takes it from: src-tauri/binaries/fleet-<target
// triple>[.exe] (Tauri's externalBin, which installs it beside the window's program as `fleet`, where
// main.rs looks first). The executable is the one apps/fleet builds with Bun (every app inside it),
// built now unless it's there already or --skip-build says to use what's there.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const triple = /host: (\S+)/.exec(execFileSync('rustc', ['-vV'], { encoding: 'utf8' }))?.[1];
if (!triple) throw new Error("rustc didn't say which target it builds for.");

// The kit's build names its files by platform (update.js buildTargets): fleet-windows-x64.exe, …
const os = triple.includes('windows') ? 'windows' : triple.includes('apple') ? 'macos' : 'linux';
const arch = triple.startsWith('aarch64') ? 'arm64' : 'x64';
const exe = os === 'windows' ? '.exe' : '';
const built = `${root}apps/fleet/dist/fleet-${os}-${arch}${exe}`;

if (!existsSync(built) || !process.argv.includes('--skip-build')) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  execFileSync(npm, ['run', 'build', '-w', 'apps/fleet'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
}
if (!existsSync(built)) throw new Error(`No ${built} after building Fleet.`);

const out = new URL('../src-tauri/binaries/', import.meta.url);
mkdirSync(out, { recursive: true });
const target = new URL(`fleet-${triple}${exe}`, out);
copyFileSync(built, target);
if (!exe) chmodSync(target, 0o755);
console.log(`Fleet for ${triple}: ${fileURLToPath(target)}`);
