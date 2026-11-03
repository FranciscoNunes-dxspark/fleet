// The project's environments (the kit's environments.js: .fleet/project.json, chosen once for every
// app) as Hail sees them. Hail has environments of its own already, in http-client.env.json beside the
// file; a project environment's "hail": { "env": "<name>" } says which of those it stands for, so
// choosing the project's staging (here, in another app or in Fleet) has Hail's variables come from its
// staging too. Pure but for reading the project's file and the choice.
import { currentEnvironment, readProject } from '@fleet/kit/environments.js';

// Methods that only read: sending one to production needs no question.
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS', 'SSE']);

/** Whether `method` only reads (GET, HEAD, OPTIONS, and SSE, a GET); a GraphQL, gRPC or WebSocket one may change things. */
export const isSafeMethod = (method) => SAFE.has(String(method ?? 'GET').toUpperCase());

/** The Hail environment a project environment's settings name (its "hail": { "env" }), or null. */
export const hailEnvOf = (settings) => (typeof settings?.hail?.env === 'string' && settings.hail.env.trim() ? settings.hail.env.trim() : null);

/**
 * Whether Hail's environment `hailEnv` is production for the project `dir` is in: { name, prod: true }
 * (the project environment's name) or null. It is when a project environment marked "prod": true
 * names it, or when the project's chosen environment is production and names no other of Hail's.
 */
export function productionFor(dir, hailEnv, opts) {
  if (!dir) return null;
  const project = readProject(dir);
  if (!project || project.error) return null;
  for (const name of project.names) {
    const s = project.environments[name];
    if (s.prod === true && hailEnv && hailEnvOf(s) === hailEnv) return { name, prod: true };
  }
  const current = currentEnvironment(dir, opts);
  if (current?.prod && (!hailEnvOf(current.settings) || hailEnvOf(current.settings) === hailEnv)) return { name: current.name, prod: true };
  return null;
}

/**
 * A name typed for /compare as one of Hail's environments: Hail's own (any case) first, then a project
 * environment's, through its "hail": { "env" }. { env, via? } (`via` the project environment's name) or
 * { error }.
 */
export function hailEnvironmentNamed(name, { names = [], dir = null } = {}) {
  const n = String(name ?? '').trim();
  const own = names.find((x) => x.toLowerCase() === n.toLowerCase());
  if (own) return { env: own };
  const project = dir ? readProject(dir) : null;
  const pname = project && !project.error ? project.names.find((x) => x.toLowerCase() === n.toLowerCase()) : null;
  if (pname) {
    const env = hailEnvOf(project.environments[pname]);
    if (!env) return { error: `The project's ${pname} names no environment of Hail's ("hail": { "env": "…" } in .fleet/project.json).` };
    if (!names.includes(env)) return { error: `The project's ${pname} is Hail's ${env}, which http-client.env.json doesn't have.` };
    return { env, via: pname };
  }
  const theirs = project && !project.error ? `; the project's: ${project.names.join(', ')}` : '';
  return { error: `There's no environment called ${n}. Hail's: ${names.join(', ') || 'none'}${theirs}.` };
}

/** The project's environment names, for completing /project-env; [] without a project. */
export function projectEnvironmentNames(dir) {
  const project = dir ? readProject(dir) : null;
  return project && !project.error ? project.names : [];
}
