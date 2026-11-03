// wharf security: the security check without the screen, for a pipeline or a quick look. It judges
// every container Docker has (one `docker inspect`), or with --compose the compose files named
// (Docker isn't asked then), prints the findings (or --json, the kit's securityJson) and exits 1 when
// one is as bad as --fail-on (high unless given), 0 when none is, 2 when it couldn't run.
import { resolve } from 'node:path';
import { failingFindings, findingsText, parseFailOn, securityJson, withoutIgnoredFindings } from '@fleet/kit/findings.js';
import { dockerProblem } from './docker.js';
import { judgeCompose, judgeInspect } from './security.js';

/** { command, compose: [paths], failOn, json } from the arguments after `wharf`; an `error` when they don't add up. */
export function parseArgs(args) {
  const [command, ...rest] = args;
  const opts = { command, compose: [], failOn: 'high', json: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--json') opts.json = true;
    else if (a === '--fail-on') opts.failOn = String(rest[++i] ?? '').toLowerCase();
    else if (a === '--compose' || a === '-f') {
      const file = rest[++i];
      if (!file) return { ...opts, error: `${a} needs a compose file` };
      opts.compose.push(file);
    } else return { ...opts, error: `Unknown option ${a}` };
  }
  if (!parseFailOn(opts.failOn)) return { ...opts, error: '--fail-on is one of critical, high, medium, low, none' };
  return opts;
}

/** A path as a finding's `where` says it: as the person wrote it, with / between folders. */
export const shownPath = (path) => String(path).replace(/\\/g, '/');

/**
 * What the check finds: the containers' (`ids`, all of them when not given) or the compose files'
 * (`compose`, read relative to `cwd`), without what `ignore` names (the config's `securityIgnore`).
 * Resolves { findings, target, checked }.
 */
export async function securityCheck(provider, { compose = [], ids, cwd = process.cwd(), ignore = [], signal } = {}) {
  if (compose.length) {
    const findings = [];
    for (const file of compose) {
      let text;
      try {
        text = await provider.readFile(resolve(cwd, file));
      } catch (e) {
        throw new Error(`Couldn't read ${file}: ${e.code === 'ENOENT' ? 'no such file' : String(e.message).split('\n')[0]}`);
      }
      findings.push(...judgeCompose(shownPath(file), text));
    }
    return { findings: withoutIgnoredFindings(findings, ignore), target: compose.map(shownPath).join(', '), checked: compose.length, check: 'compose' };
  }
  const list = ids ?? (await provider.containers({ signal })).map((c) => c.id);
  const inspected = await provider.inspectAll(list, { signal });
  return { findings: withoutIgnoredFindings(judgeInspect(inspected), ignore), target: provider.name === 'docker' ? 'containers' : `containers (${provider.name})`, checked: list.length, check: 'containers' };
}

/** Runs `wharf security`; resolves the exit code. `write` prints, `provider` is docker.js's (demo.js's in tests). */
export async function runHeadless(args, { provider, config = {}, write = (s) => process.stdout.write(s), cwd = process.cwd(), now } = {}) {
  const opts = parseArgs(args);
  if (opts.error) {
    write(`wharf ${opts.command}: ${opts.error}\n`);
    return 2;
  }
  try {
    const r = await securityCheck(provider, { compose: opts.compose, cwd, ignore: config.securityIgnore ?? [] });
    const failing = failingFindings(r.findings, opts.failOn);
    if (opts.json) write(`${JSON.stringify(securityJson({ app: 'wharf', check: r.check, target: r.target, findings: r.findings, extra: { checked: r.checked }, ...(now ? { now } : {}) }), null, 2)}\n`);
    else {
      const what = r.check === 'compose' ? `${r.checked} compose file${r.checked === 1 ? '' : 's'}: ${r.target}` : `${r.checked} container${r.checked === 1 ? '' : 's'}`;
      write(findingsText(r.findings, { failOn: opts.failOn, header: `How ${what} run` }));
    }
    return failing.length ? 1 : 0;
  } catch (e) {
    const problem = opts.compose.length ? null : dockerProblem(e.message);
    write(`wharf ${opts.command}: ${problem ?? String(e.message).split('\n')[0]}\n`);
    return 2;
  }
}
