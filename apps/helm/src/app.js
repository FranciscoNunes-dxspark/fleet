// Who this app is, for the kit (@fleet/kit): its name in release files, tags and messages, and its
// version, baked into a build as process.env.HELM_VERSION by the kit's scripts/build.js.
import { configureApp } from '@fleet/kit/app.js';

export const APP = configureApp({
  name: 'helm',
  title: 'Helm',
  version: process.env.HELM_VERSION,
  packageUrl: new URL('../package.json', import.meta.url),
  look: 'shell',
});

export const { VERSION, COMPILED } = APP;
export default APP;
