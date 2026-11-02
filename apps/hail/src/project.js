// The project's environments (the kit's environments.js: .fleet/project.json, chosen once for every
// app) as Hail sees them. Hail has environments of its own already, in http-client.env.json beside the
// file; a project environment's "hail": { "env": "<name>" } says which of those it stands for, so
// choosing the project's staging (here, in another app or in Fleet) has Hail's variables come from its
// staging too. Pure but for reading the project's file and the choice.
import { currentEnvironment, readProject } from '@fleet/kit/environments.js';

// Methods that only read: sending one to production needs no question.
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Whether `method` only reads (GET, HEAD, OPTIONS); a GraphQL, gRPC or WebSocket one may change things. */
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

/** The project's environment names, for completing /project-env; [] without a project. */
export function projectEnvironmentNames(dir) {
  const project = dir ? readProject(dir) : null;
  return project && !project.error ? project.names : [];
}
