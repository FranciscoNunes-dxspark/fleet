// Which workspaces a change touches, for the workflows: test.yml tests them, release.yml releases them.
//   node .github/scripts/changed.mjs test <base> <head>      workspaces=["packages/kit","apps/splice",…]
//   node .github/scripts/changed.mjs release <base> <head>   apps=["splice",…]
// prints a line for $GITHUB_OUTPUT. An app's own folder is that app. What every app is built from
// (packages/kit, patches/, the root package.json and package-lock.json) is all of them, and for the
// tests so are the workflows and the root's scripts. Fleet (apps/fleet, the host) is built from every
// other app, so a change to any of them is Fleet's too. Markdown changes nothing either way. With no
// usable base (a new branch, a forced push, a first commit), it's everything.
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const APPS = readdirSync(new URL('../../apps/', import.meta.url), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

const SHARED = [/^packages\/kit\//, /^patches\//, /^package(-lock)?\.json$/];
// The app that holds all the others: their changes are its changes.
const HOST = 'fleet';
const TOOLING = [/^\.github\//, /^scripts\//];

/** The apps `files` change, and whether the kit does, for `mode` ('test' or 'release'). */
export function changedApps(files, mode) {
  const apps = new Set();
  let kit = false;
  for (const file of files.filter((f) => !/\.md$/i.test(f))) {
    const own = /^apps\/([^/]+)\//.exec(file)?.[1];
    if (own && APPS.includes(own)) apps.add(own);
    else if (SHARED.some((r) => r.test(file)) || (mode === 'test' && TOOLING.some((r) => r.test(file)))) {
      APPS.forEach((a) => apps.add(a));
      kit = true;
    }
  }
  if (APPS.includes(HOST) && [...apps].some((a) => a !== HOST)) apps.add(HOST);
  return { apps: APPS.filter((a) => apps.has(a)), kit };
}

function main([mode, base, head = 'HEAD']) {
  let files = null;
  if (base && !/^0+$/.test(base)) {
    try {
      files = execFileSync('git', ['diff', '--name-only', `${base}...${head}`], { encoding: 'utf8' }).split('\n').filter(Boolean);
    } catch {
      // The base isn't in this clone (a forced push): everything.
    }
  }
  const { apps, kit } = files ? changedApps(files, mode) : { apps: APPS, kit: true };
  console.error(files ? `${files.length} files changed: ${apps.join(', ') || 'no app'}${kit ? ', and the kit' : ''}.` : 'No base to compare with: everything.');
  if (mode === 'release') console.log(`apps=${JSON.stringify(apps)}`);
  else console.log(`workspaces=${JSON.stringify([...(kit ? ['packages/kit'] : []), ...apps.map((a) => `apps/${a}`)])}`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main(process.argv.slice(2));
