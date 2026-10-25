// Applies patches/ (the Ink patch) after every install, as `patch-package` would. An install without
// the dev dependencies (`npm ci --omit=dev`, as a host serving Keel's web app may run) has no
// patch-package and needs no patch, since Ink only draws the terminal apps: it says so and carries on.
// A patch that no longer applies still fails the install.
//
// Then it builds Keel's web app when it hasn't been built: Hostinger runs only `npm install` and
// has no build command to set, so without this Keel starts with no UI. Each deploy is a fresh
// clone, so it builds every time there; a checkout builds once, and `npm run build` refreshes it.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

let bin;
try {
  bin = require.resolve('patch-package/index.js');
} catch {
  console.log('patch-package is not installed (an install without dev dependencies), so Ink is left unpatched.');
}
if (bin) {
  const { status } = spawnSync(process.execPath, [bin], { stdio: 'inherit', cwd: root });
  if (status !== 0) process.exit(status ?? 1);
}

const keel = path.join(root, 'apps', 'keel');
if (existsSync(path.join(keel, 'vite.config.js')) && !existsSync(path.join(keel, 'dist', 'index.html'))) {
  let vite;
  try {
    vite = path.join(path.dirname(createRequire(path.join(keel, 'package.json')).resolve('vite/package.json')), 'bin', 'vite.js');
  } catch {
    console.log("Vite is not installed, so Keel's web app is left unbuilt.");
  }
  if (vite) {
    console.log("Building Keel's web app (apps/keel/dist)...");
    const { status } = spawnSync(process.execPath, [vite, 'build'], { stdio: 'inherit', cwd: keel });
    // A failed build leaves the terminal apps usable, so it doesn't fail the install; Keel says "UI not built".
    if (status !== 0) console.log("Keel's web app didn't build (see above); run npm run build to try again.");
  }
}
