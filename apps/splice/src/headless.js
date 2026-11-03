// splice security: /secrets without the screen, for a pipeline and for Fleet's security overview. It prints
// the findings (or the kit's security JSON, or SARIF) and its exit code says whether one is as bad as
// --fail-on (high unless given): 0 fine, 1 found, 2 couldn't run.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { failingFindings, parseFailOn, securityJson, toSarif } from '@fleet/kit/findings.js';
import { git } from './git.js';
import { historyText, readHistory } from './secrets.js';

export const SECURITY_USAGE = 'splice security [folder] [--json] [--sarif [file]] [--fail-on critical|high|medium|low|none] [--all]';

/**
 * { dir, json, sarif, sarifFile, failOn, all } from the arguments after `splice security`; an `error` when
 * they don't add up. The word after --sarif is its file unless it starts with -, so a folder goes before it.
 */
export function parseSecurityArgs(args) {
  const opts = { dir: '.', json: false, sarif: false, sarifFile: null, failOn: 'high', all: false };
  let dirGiven = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') opts.json = true;
    else if (a === '--all') opts.all = true;
    else if (a === '--sarif') {
      opts.sarif = true;
      if (args[i + 1] != null && !args[i + 1].startsWith('-')) opts.sarifFile = args[++i];
    } else if (a === '--fail-on') {
      const v = parseFailOn(args[++i]);
      if (!v) return { ...opts, error: '--fail-on is one of critical, high, medium, low, none' };
      opts.failOn = v;
    } else if (a.startsWith('-')) return { ...opts, error: `Unknown option ${a}` };
    else if (dirGiven) return { ...opts, error: `One folder at a time (${opts.dir}, then ${a})` };
    else [opts.dir, dirGiven] = [a, true];
  }
  return opts;
}

/**
 * Runs `splice security`; resolves the exit code. `write` prints. With --json the kit's securityJson
 * ({ app: 'splice', check: 'history', target, at, counts, commits, truncated, findings }), each finding
 * with { where, line, commit, author, date, inTree }; with --sarif, SARIF to the file named or else printed.
 */
export async function runSecurity(args, { write = (s) => process.stdout.write(s), version = '0.0.0', now } = {}) {
  const opts = parseSecurityArgs(args);
  if (opts.error) {
    write(`splice security: ${opts.error}\n${SECURITY_USAGE}\n`);
    return 2;
  }
  try {
    const dir = resolve(opts.dir);
    const root = (await git(dir, ['rev-parse', '--show-toplevel']).catch(() => '')).trim();
    if (!root) {
      write(`splice security: ${dir} isn't in a git repository.\n`);
      return 2;
    }
    const range = opts.all ? ['--all'] : ['HEAD'];
    const found = await readHistory({ root: resolve(root), range });
    const { findings } = found;
    if (opts.sarif) {
      const sarif = `${JSON.stringify(toSarif({ tool: 'Splice', version, uri: 'https://github.com/FranciscoNunes-dxspark/fleet/tree/main/apps/splice', findings }), null, 2)}\n`;
      if (opts.sarifFile) writeFileSync(resolve(opts.sarifFile), sarif);
      else if (!opts.json) write(sarif);
    }
    if (opts.json) {
      const extra = { range: opts.all ? 'all' : 'HEAD', commits: found.commits, truncated: found.truncated };
      write(`${JSON.stringify(securityJson({ app: 'splice', check: 'history', target: found.root, findings, extra, ...(now ? { now } : {}) }), null, 2)}\n`);
    } else if (!opts.sarif || opts.sarifFile) {
      write(historyText({ ...found, what: opts.all ? 'every branch and tag' : 'the current branch' }, { failOn: opts.failOn }));
    }
    return failingFindings(findings, opts.failOn).length ? 1 : 0;
  } catch (e) {
    write(`splice security: ${String(e.message).split('\n')[0]}\n`);
    return 2;
  }
}
