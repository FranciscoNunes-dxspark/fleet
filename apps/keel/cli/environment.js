// The project's environment (the kit's environments.js) as Keel reads it: its `keel` section's
// `environment` names an Azure DevOps environment or release stage ("Production", "Live-EU"). That one
// goes first wherever the terminal app lists deployments, and DORA takes it as production. In an
// environment the project marks "prod": true, every change Keel makes to a deployment asks first,
// with the kit's productionQuestion. Pure, so the tests can check it.
import { productionQuestion } from '@fleet/kit/environments.js';

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether `name` (a stage, a monitor, "Approve Release-65 to Production") names `environment`, as a whole word, any case. */
export function namesEnvironment(name, environment) {
  const e = String(environment ?? '').trim();
  if (!e || !name) return false;
  return new RegExp(`(^|[^\\p{L}\\p{N}_-])${escape(e)}($|[^\\p{L}\\p{N}_-])`, 'iu').test(String(name));
}

/** `list` with what names the environment first, the rest in their order; `namesOf(x)` gives each one's names. */
export function environmentFirst(list, environment, namesOf) {
  if (!environment) return list;
  const hit = (x) => namesOf(x).some((n) => namesEnvironment(n, environment));
  return [...list.filter(hit), ...list.filter((x) => !hit(x))];
}

/** A production monitor's names: its own, and the stage it's linked to. */
export const monitorNames = (m) => [m.name, m.link?.stage].filter(Boolean);
/** A release pipeline's names: its stages'. */
export const releaseNames = (d) => (d.stages ?? []).map((s) => s.name);

/**
 * Whether a change to `names` (the stages or deployment it touches; `true` for something that
 * deploys without a stage to name, such as a deploying pipeline) is a change in production: the
 * chosen environment is "prod": true, and it names one of them (or names none, so all count).
 */
export function inProduction(env, names) {
  if (!env?.prod) return false;
  if (names === true) return true;
  const list = (names ?? []).filter(Boolean);
  if (!list.length) return false;
  return !env.environment || list.some((n) => namesEnvironment(n, env.environment));
}

/**
 * The question to ask before `req` (a confirm's { title, detail, options }), made the kit's production
 * question when the change is in production: its title says so, and it's drawn as a danger.
 */
export function productionAsk(env, names, req) {
  if (!inProduction(env, names)) return req;
  const q = productionQuestion(env, req.title.replace(/\?$/, ''));
  return { ...req, title: q.title, detail: [q.detail, req.detail].filter(Boolean).join(' '), danger: true };
}

/** What the header says about the environment: its name, and whether it's production. */
export const environmentLabel = (env) => (env ? `${env.name}${env.prod ? ' (production)' : ''}${env.environment ? ` · ${env.environment}` : ''}` : '');
