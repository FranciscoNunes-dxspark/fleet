// The project's environment (the kit's environments.js: dev, staging, prod, chosen once for every app)
// as Bosun applies it to the crew. Bosun's section of .fleet/project.json says two things, both
// optional: `profile`, the bosun.json profile the crew runs with there, and `variables`, settings
// added to every process Bosun starts. Every process also gets FLEET_ENV, the environment's name.
// The project file is meant to be committed and names things, never secrets, so a variable whose name
// (or value) reads as a secret is left out and said: those belong in an env file. Pure.
import { MASK, maskValue } from '@fleet/kit/family.js';

// The family's rule (a password, token, key…), and connection strings, which carry one more often than not.
const SECRETISH = /conn(ection)?[-_]?str(ing)?|\bdsn\b|_dsn$|cert(ificate)?[-_]?(key|pass)/i;

/** Whether a variable named `name` (holding `value`) reads as a secret. */
export function looksSecret(name, value = 'x') {
  const s = String(value);
  return maskValue(name, s) === MASK || SECRETISH.test(name) || maskValue('', s) !== s;
}

/**
 * What `env` (useEnvironment's: { name, prod, profile?, variables? }, or null) gives every process:
 * { vars: { FLEET_ENV, ...variables }, refused: [{ name, why }] }. Nothing without an environment.
 */
export function environmentVars(env) {
  if (!env?.name) return { vars: {}, refused: [] };
  const vars = {};
  const refused = [];
  const given = env.variables && typeof env.variables === 'object' && !Array.isArray(env.variables) ? env.variables : {};
  for (const [name, value] of Object.entries(given)) {
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name)) refused.push({ name, why: "isn't a variable's name" });
    else if (!['string', 'number', 'boolean'].includes(typeof value)) refused.push({ name, why: 'is a string, a number or true/false' });
    else if (looksSecret(name, value)) refused.push({ name, why: 'reads as a secret: keep it in an env file ("envFile" in bosun.json), never in .fleet/project.json' });
    else vars[name] = String(value);
  }
  // FLEET_ENV last, so the section can't say another name than the one chosen.
  vars.FLEET_ENV = env.name;
  return { vars, refused };
}

/**
 * The profile the environment runs the crew with: { profile } (a name in `profiles`, or null when it
 * names none), or { problem } when it names one bosun.json doesn't have.
 */
export function environmentProfile(env, profiles = {}) {
  const wanted = env?.profile;
  if (wanted == null || wanted === '') return { profile: null };
  if (typeof wanted !== 'string' || !Object.hasOwn(profiles, wanted)) return { problem: `${env.name}'s profile ${JSON.stringify(wanted)} isn't in bosun.json's "profiles"${Object.keys(profiles).length ? ` (there's ${Object.keys(profiles).join(', ')})` : ''}.` };
  return { profile: wanted };
}

/** What the environment changes, as a key: the same key means nothing to apply again. */
export const environmentKey = (env) => JSON.stringify(env ? [env.name, env.profile ?? null, env.variables ?? null] : null);
