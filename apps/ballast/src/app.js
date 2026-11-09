// Who this app is, for the kit (@fleet/kit): its name in release files, tags and messages, the
// credential store's entries, and its version, baked into a build as process.env.BALLAST_VERSION by
// the kit's scripts/build.js. Import VERSION and COMPILED from here; the entry point imports it first.
import { configureApp } from '@fleet/kit/app.js';

export const APP = configureApp({
  name: 'ballast',
  title: 'Ballast',
  version: process.env.BALLAST_VERSION,
  packageUrl: new URL('../package.json', import.meta.url),
  look: 'shell',
});

export const { VERSION, COMPILED } = APP;
export default APP;
