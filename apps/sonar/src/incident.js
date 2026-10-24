// An incident: one problem told whole, for the incident view (I in Problems, /incident). Pure: the
// stack it went through, the deployments before it, the commits that touched its files, the SQL behind
// it, the request that failed, the Markdown write-up and what Claude is asked. actions.js fetches.
import { matchFrameFile, quoteArg, stackFrames } from '@fleet/kit/family.js';
import { referenceWords, resolved } from './keyvault.js';

const HOUR = 3600_000;
const DAY = 24 * HOUR;

/**
 * The stack frames of an exception's `details` (App Insights' parsed stack: [{ parsedStack: [{ method,
 * fileName, line }] }], as an array or its JSON) or, failing that, of a stack in text: [{ file, line, method }].
 */
export function framesOf(details, text = '') {
  let d = details;
  if (typeof d === 'string') {
    try {
      d = JSON.parse(d);
    } catch {
      return stackFrames(d);
    }
  }
  const parsed = (Array.isArray(d) ? d : [])
    .flatMap((x) => x?.parsedStack ?? [])
    .filter((f) => f?.fileName)
    .map((f) => ({ file: String(f.fileName), line: Number(f.line) || null, method: f.method ?? null }));
  if (parsed.length) return parsed;
  const raw = (Array.isArray(d) ? d : []).map((x) => x?.rawStack ?? '').join('\n') || text;
  return stackFrames(raw);
}

/** The deployments that started in the `hours` before `first` (ISO), newest first; and the latest before it at all. */
export function deploymentsBefore(list, first, hours = 24) {
  const end = Date.parse(first);
  const started = (d) => Date.parse(d.start ?? '');
  const before = list.filter((d) => started(d) <= end).sort((a, b) => started(b) - started(a));
  return { within: before.filter((d) => started(d) >= end - hours * HOUR), latest: before[0] ?? null };
}

/** The checkout's files (`git ls-files`, / separated) the frames went through: [{ path, line, method }], one per file. */
export function framesInCheckout(frames, files) {
  const seen = new Map();
  const base = (p) => p.split('/').pop().toLowerCase();
  for (const f of frames) {
    const path = matchFrameFile(f.file, files);
    if (!path || seen.has(path)) continue;
    // Matched by its name alone, a file is only that one when no other file has the name.
    const parts = String(f.file).replace(/\\/g, '/').split('/');
    const two = parts.length > 1 && path.toLowerCase().endsWith(parts.slice(-2).join('/').toLowerCase());
    if (two || files.filter((x) => base(x) === base(path)).length === 1) seen.set(path, { path, line: f.line, method: f.method });
  }
  return [...seen.values()];
}

/** The `git log` command for the commits that touched `paths` in the 14 days before `first`. */
export function gitLogCommand(paths, first, days = 14) {
  const until = new Date(Date.parse(first)).toISOString();
  const since = new Date(Date.parse(first) - days * DAY).toISOString();
  return `git log --no-color --since=${since} --until=${until} --format=%H%x09%an%x09%aI%x09%s -- ${paths.map((p) => quoteArg(p)).join(' ')}`;
}

/** `git log`'s lines as written by gitLogCommand: [{ hash, author, at, subject }]. */
export const parseGitLog = (out) =>
  String(out ?? '')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      const [hash, author, at, ...rest] = l.split('\t');
      return { hash, author, at, subject: rest.join('\t') };
    });

/** A SQL dependency's target as App Insights writes it ("server | database"): { server, database }. */
export function sqlTarget(target) {
  const [server, database] = String(target ?? '').split('|').map((s) => s.trim());
  return { server: server || null, database: database || null };
}

/** The failing request of an occurrence (its rows from operationQuery): the request row, or null. */
export const requestOf = (rows) => rows.find((r) => r.itemType === 'request' && r.url) ?? null;

/** A request as Hail's `/take request` context: the method from its name ("GET /api/cart"), else GET. */
export function requestContext(row) {
  if (!row?.url) return null;
  const method = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s/i.exec(row.name ?? '')?.[1]?.toUpperCase() ?? 'GET';
  return { method, url: row.url, headers: {}, body: '', name: row.name ?? `${method} ${row.url}` };
}

/** A problem's latest exception as Splice's `/take exception` context, with its frames and request when known. */
export function exceptionContext(problem, latest, request) {
  const frames = framesOf(latest?.details);
  return {
    app: problem.role ?? latest?.cloud_RoleName ?? null,
    type: latest?.type ?? problem.type,
    message: latest?.outerMessage ?? problem.message ?? '',
    frames: frames.map((f) => ({ file: f.file, line: f.line, method: f.method })),
    operationId: latest?.operation_Id ?? problem.operation ?? null,
    time: latest?.timestamp ?? problem.last ?? null,
    ...(request ? { request: requestContext(request) } : {}),
  };
}

const when = (iso) => (iso ? String(iso).replace('T', ' ').replace(/\.\d+Z$|Z$/, '') : '—');
const ago = (iso, now) => {
  const ms = now - Date.parse(iso);
  if (!(ms >= 0)) return '';
  const h = ms / HOUR;
  return h < 1 ? `${Math.round(ms / 60000)} min` : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} days`;
};

/**
 * The incident in Markdown: what `s` saves (before Claude's write-up), and what Claude is given.
 * `inc`: { problem, spark, span, latest, frames, deploys, rows, sql, request, commits, repo }.
 */
export function incidentMarkdown(inc, now = Date.now()) {
  const p = inc.problem;
  const out = [`# ${p.type}`, '', `> ${p.message ?? ''}`, ''];
  out.push(`- **App:** ${p.role ?? '—'}`);
  out.push(`- **First seen:** ${when(p.first)} · **last seen:** ${when(p.last)} (${ago(p.last, now)} ago)`);
  out.push(`- **Count:** ${p.count} in the last ${inc.span?.label ?? ''}, ${p.users} user${p.users === 1 ? '' : 's'}${inc.spark ? ` · \`${inc.spark}\`` : ''}`);
  out.push(`- **Problem id:** ${p.problemId}`, '');
  out.push('## Deployments in the 24 h before first seen', '');
  if (inc.deploys?.error) out.push(`Couldn't read them: ${inc.deploys.error}`);
  else if (inc.deploys?.within?.length) for (const d of inc.deploys.within) out.push(`- ${when(d.start)} ${d.status} by ${d.author || 'someone'}${d.deployer ? ` through ${d.deployer}` : ''}: ${d.message.split('\n')[0]}${d.active ? ' (active)' : ''}`);
  else out.push(`None.${inc.deploys?.latest ? ` The latest before it: ${when(inc.deploys.latest.start)}, ${inc.deploys.latest.message.split('\n')[0]}.` : ''}`);
  if (inc.refs?.error) out.push('', '## Key Vault references (now)', '', `Couldn't read them: ${inc.refs.error}`);
  else if (inc.refs?.length) {
    out.push('', '## Key Vault references (now)', '');
    for (const r of inc.refs) out.push(`- ${resolved(r) ? '✓' : '✗'} ${r.name}: ${referenceWords(r)}`);
  }
  out.push('', '## The latest occurrence', '');
  if (inc.rows?.length) {
    out.push('```');
    for (const r of inc.rows) out.push([when(r.timestamp).slice(11), String(r.itemType).padEnd(11), r.name ?? '', r.detail ?? '', r.success === false ? '(failed)' : '', r.duration != null ? `${Math.round(r.duration)} ms` : ''].filter(Boolean).join('  '));
    out.push('```');
  } else out.push('Not found in the span.');
  if (inc.frames?.length) {
    out.push('', '## Stack', '');
    for (const f of inc.frames) out.push(`- \`${f.method ?? '?'}\` ${f.file}${f.line ? `:${f.line}` : ''}`);
  }
  out.push('', '## Failing SQL', '');
  if (inc.sql?.length) for (const s of inc.sql) out.push(`- ${s.count}× on ${s.target}${s.resultCode ? ` (error ${s.resultCode})` : ''}${s.data ? `: \`${String(s.data).replace(/\s+/g, ' ')}\`` : ''}`);
  else out.push('None.');
  if (inc.repo) {
    out.push('', `## Commits to its files in the 14 days before first seen`, '');
    if (inc.commits?.error) out.push(`Couldn't read them: ${inc.commits.error}`);
    else if (!inc.files?.length) out.push('None of its frames is a file in this checkout.');
    else if (inc.commits?.length) for (const c of inc.commits) out.push(`- ${c.hash.slice(0, 10)} ${when(c.at)} ${c.author}: ${c.subject}`);
    else out.push(`None touched ${inc.files.map((f) => f.path).join(', ')}.`);
  }
  return out.join('\n');
}

/** What `w` in the incident asks Claude; the incident's Markdown goes on stdin. */
export const writeupPrompt = (problem) =>
  [
    `An incident in the Azure app "${problem.role}": the exception "${problem.type}". What Sonar knows about it (counts, deployments, its latest occurrence end to end, its stack, failing SQL, recent commits to its files) is on stdin, in Markdown.`,
    'Write a draft incident write-up in Markdown with these sections: Summary, Impact, Timeline, Likely cause, Next steps. If the current folder holds the app\'s source, read the code in the stack to be specific. Say what is known and what is a guess. Only the Markdown, nothing before or after it.',
  ].join(' ');

/** A file name for an incident's write-up: incident-<date>-<type>.md. */
export const incidentFile = (problem, now = Date.now()) => `incident-${new Date(now).toISOString().slice(0, 10)}-${String(problem.type).split('.').pop().replace(/[^\w-]+/g, '-').toLowerCase()}.md`;
