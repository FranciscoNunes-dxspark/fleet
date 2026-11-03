// mooring security <host>: /harden without the screen, for a pipeline. The host is a saved one (its name or
// a unique prefix, as /connect takes it) or user@host[:port]; it signs in as every ssh Mooring starts with
// BatchMode, so with a key or the agent and a host already in known_hosts. A host saved with `password`
// can't be checked here, as there is no one to ask. Prints findings.js's text (or --json) and exits 0
// fine, 1 a finding as bad as --fail-on (high unless given), 2 it couldn't run.
import { checkHardening } from './harden.js';
import { findHost, hostText, parseTarget } from './hosts.js';
import { failingFindings, findingsText, parseFailOn, securityJson } from '@fleet/kit/findings.js';

/** { target, json, failOn } from the arguments after `mooring security`; an `error` when they don't add up. */
export function parseArgs(args) {
  const opts = { target: null, json: false, failOn: 'high' };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') opts.json = true;
    else if (a === '--fail-on') {
      const v = parseFailOn(args[++i]);
      if (!v) return { ...opts, error: '--fail-on is one of critical, high, medium, low, none' };
      opts.failOn = v;
    } else if (a === '--demo') continue;
    else if (a.startsWith('-')) return { ...opts, error: `Unknown option ${a}` };
    else if (opts.target) return { ...opts, error: `One host at a time (${opts.target}, ${a})` };
    else opts.target = a;
  }
  if (!opts.target) return { ...opts, error: 'Which host? mooring security <host> [--json] [--fail-on level]' };
  return opts;
}

/** The host `target` means: a saved one, or user@host[:port]. { host } or { error }. */
export function resolveHost(target, hosts = []) {
  const saved = findHost(hosts, target);
  if (saved) return { host: saved };
  if (!target.includes('@') && !target.includes('.') && !target.includes(':')) return { error: `There's no saved host ${target}${hosts.length ? ` (${hosts.map((h) => h.name).join(', ')})` : ''}, and it isn't user@host.` };
  const t = parseTarget(target);
  return t.error ? { error: t.error } : { host: { name: target, ...t } };
}

/** Runs `mooring security …`; resolves the exit code. `makeSession(host)` is session.js's createSession (the demo's in tests). */
export async function runSecurity(args, { config = {}, makeSession, write = (s) => process.stdout.write(s), now = new Date() }) {
  const opts = parseArgs(args);
  const fail = (text) => {
    write(`mooring security: ${text}\n`);
    return 2;
  };
  if (opts.error) return fail(opts.error);
  const { host, error } = resolveHost(opts.target, config.hosts);
  if (error) return fail(error);
  if (host.password) return fail(`${host.name} signs in with a password, which there is no one to ask for here. Give it a key (in Mooring: /keygen ${host.name}) or load one into ssh-agent.`);
  const session = makeSession(host);
  let result;
  try {
    result = await checkHardening(session, { host: host.name, now });
  } catch (e) {
    return fail(String(e.message).split('\n')[0]);
  } finally {
    await session.close?.();
  }
  if (!result.ran) return fail(result.unchecked[0]);
  const failing = failingFindings(result.findings, opts.failOn);
  if (opts.json) {
    write(`${JSON.stringify(securityJson({ app: 'mooring', check: 'harden', target: host.name, findings: result.findings, extra: { host: hostText(host), facts: result.facts, unchecked: result.unchecked }, now }), null, 2)}\n`);
  } else {
    write(findingsText(result.findings, { failOn: opts.failOn, header: `Hardening of ${host.name} (${hostText(host)})\n` }));
    if (result.unchecked.length) write(`\nCouldn't tell:\n${result.unchecked.map((u) => `  ${u}`).join('\n')}\n`);
  }
  return failing.length ? 1 : 0;
}
