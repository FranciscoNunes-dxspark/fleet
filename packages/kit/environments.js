// A project's environments (dev, staging, prod), named once for every app: `.fleet/project.json` in the
// project (its git checkout's root, or a folder above the one an app runs in) says what each
// environment means to each app, and the one chosen is kept per project in the family's folder
// (~/.family/env.json), so choosing it in one app (or in Fleet, ctrl+b e) moves them all. Nothing
// secret goes in the file: it names things (a Trawl connection, a key vault, an App Service app, a
// kube context), never a password or a connection string.
//
//   {
//     "default": "dev",
//     "environments": {
//       "dev":  { "hail": { "env": "dev" }, "trawl": { "connection": "Shop (dev)" } },
//       "prod": { "prod": true, "sonar": { "app": "shop-api", "resourceGroup": "rg-shop" }, "locker": { "vault": "kv-shop" } }
//     }
//   }
//
// What each app reads from its section is its own (its README says); `prod: true` marks an environment
// where every app draws its frames red and asks before it changes anything.
import { existsSync, mkdirSync, readFileSync, renameSync, unwatchFile, watchFile, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { familyDir, logActivity, repoRoot } from './family.js';
import { theme } from './theme.js';

export const PROJECT_FILE = join('.fleet', 'project.json');
const SELECTION_FILE = 'env.json';

/** The .fleet/project.json that covers `dir`: in it or a folder above, no higher than its checkout's root; or null. */
export function findProjectFile(dir) {
  const top = repoRoot(dir);
  for (let d = resolve(dir); ; d = dirname(d)) {
    const file = join(d, PROJECT_FILE);
    if (existsSync(file)) return file;
    if (d === top || dirname(d) === d) return null;
  }
}

/**
 * The project's environments: { root, file, names, default, environments } (`root` the folder holding
 * .fleet), { root, file, error } when the file can't be read, or null when there's none.
 */
export function readProject(dir) {
  const file = findProjectFile(dir);
  if (!file) return null;
  const root = dirname(dirname(file));
  try {
    const json = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    const environments = json?.environments && typeof json.environments === 'object' ? json.environments : {};
    const names = Object.keys(environments).filter((n) => environments[n] && typeof environments[n] === 'object');
    if (!names.length) return { root, file, error: 'it names no environments ("environments": { "dev": { … } })' };
    return { root, file, names, default: names.includes(json.default) ? json.default : names[0], environments };
  } catch (e) {
    return { root, file, error: String(e.message).split('\n')[0] };
  }
}

const selectionPath = (dir = familyDir()) => join(dir, SELECTION_FILE);

// The watchers in this process, told straight away when this process switches, rather than at their
// next poll: an app that runs /env sees its own switch at once.
const listeners = new Set();

function readSelection(home) {
  try {
    return JSON.parse(readFileSync(selectionPath(home), 'utf8')) ?? {};
  } catch {
    return {};
  }
}

/**
 * The environment chosen for the project `dir` is in: { name, prod, settings, root, names }, the
 * project's default until one is chosen; null when the project names none (or its file is broken).
 */
export function currentEnvironment(dir, { home = familyDir() } = {}) {
  const project = readProject(dir);
  if (!project || project.error) return null;
  const chosen = readSelection(home)[project.root];
  const name = project.names.includes(chosen) ? chosen : project.default;
  const settings = project.environments[name];
  return { name, prod: settings.prod === true, settings, root: project.root, names: project.names, environments: project.environments };
}

/** What the chosen environment says to `app`: { name, prod, ...its section }, or null with no environments. */
export function environmentFor(app, dir, opts) {
  const env = currentEnvironment(dir, opts);
  if (!env) return null;
  const own = env.settings[app];
  return { ...(own && typeof own === 'object' ? own : {}), name: env.name, prod: env.prod };
}

/**
 * Chooses environment `name` for the project `dir` is in, for every app: { ok: true, env } or
 * { ok: false, error }. `by` (an app's name) logs it in the family's activity.
 */
export function setEnvironment(dir, name, { by = 'fleet', home = familyDir() } = {}) {
  const project = readProject(dir);
  if (!project) return { ok: false, error: `No ${PROJECT_FILE.split('\\').join('/')} here or above: it names the project's environments.` };
  if (project.error) return { ok: false, error: `${project.file} can't be read: ${project.error}` };
  const wanted = project.names.find((n) => n.toLowerCase() === String(name ?? '').trim().toLowerCase());
  if (!wanted) return { ok: false, error: `No environment ${String(name ?? '').trim() || '(none given)'}: ${project.names.join(', ')}.` };
  try {
    mkdirSync(home, { recursive: true });
    const all = { ...readSelection(home), [project.root]: wanted };
    writeFileSync(`${selectionPath(home)}.tmp`, JSON.stringify(all, null, 2));
    renameSync(`${selectionPath(home)}.tmp`, selectionPath(home));
  } catch (e) {
    return { ok: false, error: `Couldn't keep the choice: ${e.message}` };
  }
  logActivity(by, { text: `Switched ${basename(project.root)} to ${wanted}${project.environments[wanted].prod === true ? ' (production)' : ''}`, kind: 'change', project: project.root }, { dir: home });
  for (const check of [...listeners]) check();
  return { ok: true, env: currentEnvironment(dir, { home }) };
}

/** Whether the project's environment `name` (another than the chosen one, say) is marked production. */
export function isProduction(dir, name) {
  const project = readProject(dir);
  return Boolean(project && !project.error && project.environments[name]?.prod === true);
}

/**
 * A sentence for an app's /env with no argument: which one, and the others. `command` is the slash
 * command that switches it in this app (Hail's is /project-env, its /env being its own environments).
 */
export function describeEnvironments(dir, opts = {}) {
  const command = opts.command ?? '/env';
  const project = readProject(dir);
  if (!project) return `No environments: a ${PROJECT_FILE.split('\\').join('/')} names them (dev, staging, prod) for every app.`;
  if (project.error) return `${project.file} can't be read: ${project.error}`;
  const env = currentEnvironment(dir, opts);
  return `Environment: ${env.name}${env.prod ? ' (production)' : ''}. ${project.names.length > 1 ? `${command} ${project.names.filter((n) => n !== env.name).join('|')} switches every app.` : ''}`.trim();
}

/**
 * Calls `onChange(env)` (currentEnvironment's) whenever the choice or the project's file changes, from
 * this app or another; returns the function that stops it. Polls the two files once a second.
 */
export function watchEnvironment(dir, onChange, { home = familyDir(), interval = 1000 } = {}) {
  const files = [selectionPath(home), findProjectFile(dir) ?? join(resolve(dir), PROJECT_FILE)];
  let last = JSON.stringify(currentEnvironment(dir, { home }));
  const check = () => {
    const env = currentEnvironment(dir, { home });
    const now = JSON.stringify(env);
    if (now === last) return;
    last = now;
    onChange(env);
  };
  for (const f of files) watchFile(f, { interval, persistent: false }, check);
  listeners.add(check);
  return () => {
    listeners.delete(check);
    for (const f of files) unwatchFile(f, check);
  };
}

/** Whether the frames are drawn red: on for a production environment. The kit's Panel reads it while drawing. */
export function markProduction(on) {
  theme.envProd = Boolean(on);
}

/**
 * The question to ask before `what` changes something in a production environment, for an app's own
 * confirm ({ title, detail, danger }); null when `env` isn't production, so callers can skip asking.
 */
export function productionQuestion(env, what) {
  if (!env?.prod) return null;
  return { title: `${env.name} is production. ${what}?`, detail: 'The project marks this environment "prod": true.', danger: true };
}
