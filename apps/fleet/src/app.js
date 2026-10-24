// Who the host is, for the kit (@fleet/kit): its name in release files and tags (fleet-linux-x64,
// fleet-v0.1.0) and its version, baked into a build as process.env.FLEET_VERSION by the kit's
// scripts/build.js. The host's entry (src/cli.js) imports it first. The hidden `fleet --run <app>`
// (src/main.js) never does: that process is the app it runs, which configures itself.
import { configureApp } from '@fleet/kit/app.js';

export const APP = configureApp({
  name: 'fleet',
  title: 'Fleet',
  version: process.env.FLEET_VERSION,
  packageUrl: new URL('../package.json', import.meta.url),
});

export const { VERSION, COMPILED } = APP;
export default APP;
