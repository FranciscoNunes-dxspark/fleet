// Which app is running the kit. The kit's files are the same in every app, but a few things carry the
// app's name: the credential store's entries (`Trawl:<name>`), the release files (`trawl-linux-x64`),
// the version baked into a build (TRAWL_VERSION), the updater's tags (`trawl-v1.2.3`) and some messages.
// Each app says who it is once, in its own src/app.js (Keel: cli/app.js), which everything that needs
// the version imports, so it has run before anything asks:
//   export const { VERSION, COMPILED } = configureApp({ name: 'trawl', title: 'Trawl', version: process.env.TRAWL_VERSION, packageUrl: new URL('../package.json', import.meta.url) });
// `version` must be written as `process.env.<NAME>_VERSION` there: the build (scripts/build.js) defines
// that expression, which a computed name wouldn't match.
import { readFileSync } from 'node:fs';

let current = null;

/** Names a build defines for `name`: the version's environment variable, TRAWL_VERSION. */
export const versionVariable = (name) => `${String(name).toUpperCase().replace(/[^A-Z0-9]/g, '_')}_VERSION`;

/**
 * Says which app this is. `name` is lower case (file names, tags, the user agent), `title` as people
 * read it (messages, the credential store's service; it must never change, or saved passwords are
 * lost), `version` the built-in one (undefined from a checkout, which reads `packageUrl`'s package.json).
 * Returns the app: { name, title, versionVariable, VERSION, COMPILED, packageUrl, credentialService }.
 */
export function configureApp({ name, title, version, packageUrl, credentialService = title }) {
  if (!/^[a-z][a-z0-9-]*$/.test(name ?? '')) throw new Error(`configureApp needs a lower-case name, not ${JSON.stringify(name)}`);
  if (!title) throw new Error('configureApp needs a title');
  if (current && current.name !== name) throw new Error(`This process is ${current.title}; it can't also be ${title}.`);
  const variable = versionVariable(name);
  const baked = version ?? process.env[variable];
  const VERSION = baked ?? (packageUrl ? JSON.parse(readFileSync(packageUrl, 'utf8')).version : '0.0.0');
  current = Object.freeze({ name, title, versionVariable: variable, VERSION, COMPILED: baked != null, packageUrl, credentialService });
  return current;
}

/** The app configureApp named. Throws when none has: something ran before the app's src/app.js. */
export function app() {
  if (!current) throw new Error("No app is configured: import the app's src/app.js (configureApp) first.");
  return current;
}

/** Whether configureApp has run. */
export const appConfigured = () => current != null;
