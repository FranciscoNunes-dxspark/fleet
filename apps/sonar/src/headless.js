// sonar security: the posture check (posture/check.js) without the screen, for a pipeline. It prints
// the findings (or --json, the kit's securityJson, or --sarif) and its exit code says whether one is as
// bad as --fail-on (high unless given): 0 fine, 1 found, 2 couldn't run.
import { failingFindings, findingsText, parseFailOn, securityJson, toSarif, withoutIgnoredFindings } from '@fleet/kit/findings.js';
import { postureCheck, readLine } from './posture/check.js';

/** { command, subscription, resourceGroup, failOn, json, sarif, ignore, defender } from the arguments after `sonar`; an `error` when they don't add up. */
export function parseArgs(args) {
  const [command, ...rest] = args;
  const opts = { command, subscription: null, resourceGroup: null, failOn: 'high', json: false, sarif: false, ignore: [], defender: true };
  const value = (i, flag) => {
    const v = rest[i + 1];
    return v == null || v.startsWith('--') ? { error: `${flag} needs a value` } : { v };
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--json') opts.json = true;
    else if (a === '--sarif') opts.sarif = true;
    else if (a === '--no-defender') opts.defender = false;
    else if (['--subscription', '--sub', '--resource-group', '-g', '--fail-on', '--ignore'].includes(a)) {
      const { v, error } = value(i++, a);
      if (error) return { ...opts, error };
      if (a === '--subscription' || a === '--sub') opts.subscription = v;
      else if (a === '--resource-group' || a === '-g') opts.resourceGroup = v;
      else if (a === '--fail-on') opts.failOn = v.toLowerCase();
      else opts.ignore.push(...v.split(',').map((s) => s.trim()).filter(Boolean));
    } else return { ...opts, error: `Unknown option ${a}` };
  }
  if (!parseFailOn(opts.failOn)) return { ...opts, error: '--fail-on is one of critical, high, medium, low, none' };
  if (opts.json && opts.sarif) return { ...opts, error: '--json or --sarif, not both' };
  return opts;
}

/** The subscription asked for (by id or name), or the one az has selected, or the only one. */
async function subscriptionFor(provider, wanted) {
  const subs = await provider.subscriptions();
  if (!subs.length) throw new Error('This sign-in has no subscriptions it can see.');
  if (wanted) {
    const w = wanted.toLowerCase();
    const sub = subs.find((s) => s.id.toLowerCase() === w || s.name.toLowerCase() === w);
    if (!sub) throw new Error(`No subscription ${wanted} in this sign-in (${subs.map((s) => s.name).join(', ')})`);
    return sub;
  }
  const current = provider.currentSubscription ? await provider.currentSubscription().catch(() => null) : null;
  return subs.find((s) => s.id === current?.id) ?? subs[0];
}

/** Runs `sonar security`; resolves the exit code. `write` prints; `provider` is arm.js's (the demo's with --demo, and in tests). */
export async function runHeadless(args, { provider, config = {}, write = (s) => process.stdout.write(s), version = '0.0.0', now = new Date() }) {
  const opts = parseArgs(args);
  if (opts.error) {
    write(`sonar ${opts.command}: ${opts.error}\n`);
    return 2;
  }
  try {
    const sub = await subscriptionFor(provider, opts.subscription);
    const result = await postureCheck(provider, sub.id, { resourceGroup: opts.resourceGroup, defender: opts.defender });
    const findings = withoutIgnoredFindings(result.findings, [...(config.postureIgnore ?? []), ...opts.ignore]);
    const target = `/subscriptions/${sub.id}${opts.resourceGroup ? `/resourceGroups/${opts.resourceGroup}` : ''}`;
    const failing = failingFindings(findings, opts.failOn);
    if (opts.sarif) {
      write(`${JSON.stringify(toSarif({ tool: 'Sonar', version, uri: 'https://github.com/FranciscoNunes-dxspark/fleet/tree/main/apps/sonar', findings }), null, 2)}\n`);
    } else if (opts.json) {
      // The property each finding saw is configuration, never a secret, so it stays in.
      const extra = { subscription: { id: sub.id, name: sub.name }, ...(opts.resourceGroup ? { resourceGroup: opts.resourceGroup } : {}), read: result.read, skipped: result.skipped, defender: result.defender, ignored: result.findings.length - findings.length };
      write(`${JSON.stringify(securityJson({ app: 'sonar', check: 'posture', target, findings, extra, excerpts: true, now }), null, 2)}\n`);
    } else {
      const header = `${sub.name}${opts.resourceGroup ? ` · ${opts.resourceGroup}` : ''}: ${readLine(result.read) || 'nothing read'}`;
      write(findingsText(findings, { failOn: opts.failOn, header }));
      for (const s of result.skipped) write(`Not read: ${s.what} (${s.why})\n`);
      if (opts.defender && result.defender !== 'read') write(`Defender for Cloud not read: ${result.defender}\n`);
    }
    return failing.length ? 1 : 0;
  } catch (e) {
    write(`sonar ${opts.command}: ${String(e.message).split('\n')[0]}\n`);
    return 2;
  }
}
