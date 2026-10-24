// Applies patches/ (the Ink patch) after every install, as `patch-package` would. An install without
// the dev dependencies (`npm ci --omit=dev`, as a host serving Keel's web app may run) has no
// patch-package and needs no patch, since Ink only draws the terminal apps: it says so and carries on.
// A patch that no longer applies still fails the install.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let bin;
try {
  bin = require.resolve('patch-package/index.js');
} catch {
  console.log('patch-package is not installed (an install without dev dependencies), so Ink is left unpatched.');
  process.exit(0);
}
const { status } = spawnSync(process.execPath, [bin], { stdio: 'inherit' });
process.exit(status ?? 1);
