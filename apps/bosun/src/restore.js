// /replay's `r`: the crew put back as it was at a moment of a recording, as far as Bosun can. Pure:
// `restorePlan` says what to start, stop and switch, and what can't be put back (a process gone from
// the crew, a profile gone, env files that changed, another checkout); actions.js asks and does it.
import { envHash } from './recorder.js';

/** Whether a process was meant to run at that moment: up, coming up, or waiting to restart. */
export const wasRunning = (p) => p.status === 'starting' || p.status === 'running' || (p.restartAt != null && !p.gaveUp);

/** Whether a process of the supervisor's runs now (or waits to restart, which s cancels). */
export const runsNow = (p) => Boolean(p.child) || p.restartAt != null;

const short = (hash) => String(hash ?? '').slice(0, 12);

/**
 * then: { procs (Replayer.at), profile, git: { branch, commit } | null }
 * now: { procs (the supervisor's), profile, profiles: [names], git, tipOf(branch) → commit | null }
 * Returns { profile (undefined: leave it), start, stop, missing, envChanged, git, warnings, nothing }:
 * `git` is { branch, commit, same, line } with `line` Splice's command to check that commit out
 * (the branch, when it still points there), or null when the recording doesn't know the checkout.
 */
export function restorePlan(then, now) {
  const here = new Map(now.procs.map((p) => [p.name, p]));
  const wanted = then.procs.filter(wasRunning).map((p) => p.name);
  const start = wanted.filter((n) => here.has(n) && !runsNow(here.get(n)));
  const stop = now.procs.filter((p) => runsNow(p) && !wanted.includes(p.name)).map((p) => p.name);
  const missing = wanted.filter((n) => !here.has(n));
  const warnings = [];

  let profile;
  const wantProfile = then.profile ?? null;
  if (wantProfile !== (now.profile ?? null)) {
    if (wantProfile && !(now.profiles ?? []).includes(wantProfile)) warnings.push(`The profile ${wantProfile} isn't in the crew any more, so it stays ${now.profile ? `on ${now.profile}` : 'without one'}.`);
    else profile = wantProfile;
  }
  if (missing.length) warnings.push(`${list(missing)} ${missing.length === 1 ? "isn't" : "aren't"} in the crew any more.`);

  // The env files, for what will run: only a recording that says (`env` set at a start) can tell.
  const thenByName = new Map(then.procs.map((p) => [p.name, p]));
  const envChanged = wanted.filter((n) => {
    const was = thenByName.get(n);
    return here.has(n) && was && was.env !== undefined && was.env !== envHash(here.get(n).spec?.fileEnv);
  });
  if (envChanged.length) warnings.push(`The .env changed since then for ${list(envChanged)}: ${envChanged.length === 1 ? 'it runs' : 'they run'} with today's settings.`);

  let git = null;
  if (then.git?.commit) {
    const { branch, commit } = then.git;
    const same = now.git?.commit === commit;
    const onBranch = branch && now.tipOf?.(branch) === commit;
    git = { branch, commit, same, line: `/checkout ${onBranch ? branch : short(commit)}` };
    if (!same) warnings.push(`The checkout was ${branch ? `${branch} at ` : ''}${short(commit)} then${now.git?.commit ? `, ${now.git.branch ?? 'detached'} at ${short(now.git.commit)} now` : ''}: Bosun leaves it to Splice.`);
  }

  const nothing = !start.length && !stop.length && profile === undefined;
  return { profile, start, stop, missing, envChanged, git, warnings, nothing };
}

/** The plan in lines, for the question before it's done. */
export function planLines(plan) {
  const out = [];
  if (plan.profile !== undefined) out.push(plan.profile ? `Switch to the profile ${plan.profile}` : 'Leave the profile');
  if (plan.stop.length) out.push(`Stop ${list(plan.stop)}`);
  if (plan.start.length) out.push(`Start ${list(plan.start)}`);
  if (plan.git && !plan.git.same) out.push(`Copy ${plan.git.line} for Splice`);
  return [...out, ...plan.warnings];
}

const list = (names) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);
