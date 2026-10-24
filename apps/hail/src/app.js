// Who this app is, for the kit (@fleet/kit): its name in release files, tags and messages, the
// credential store's entries, and its version, baked into a build as process.env.HAIL_VERSION by
// the kit's scripts/build.js. Import VERSION and COMPILED from here; the entry point imports it first.
import { configureApp } from '@fleet/kit/app.js';

export const APP = configureApp({
  name: 'hail',
  title: 'Hail',
  version: process.env.HAIL_VERSION,
  packageUrl: new URL('../package.json', import.meta.url),
});

export const { VERSION, COMPILED } = APP;
export default APP;
