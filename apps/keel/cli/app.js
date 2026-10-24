// Who the terminal app is, for the kit (@fleet/kit): its name in release files and tags, and its
// version, baked into a build as process.env.KEEL_VERSION by the kit's scripts/build.js (which also
// tells server/root.js to keep .env and data in ~/.keel). The rest of cli/ reads VERSION and COMPILED
// through open.js, which the web terminal swaps for its own (vite.config.js); cli.jsx imports this first.
import { configureApp } from '@fleet/kit/app.js';

export const APP = configureApp({
  name: 'keel',
  title: 'Keel',
  version: process.env.KEEL_VERSION,
  packageUrl: new URL('../package.json', import.meta.url),
});

export const { VERSION, COMPILED } = APP;
export default APP;
