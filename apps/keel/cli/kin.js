// What Keel's terminal app does with the family (the kit's family.js, shared by every app, has the rest:
// the names, who takes what, the paste rule, the copied note): the lines it hands Splice and Sonar, where
// a failed run points in the code, what /family offers, and Pinch's mood in the family's words and its
// word on theirs. Pure, so the tests can check it.
import { relative } from 'node:path';
import { APP_NAMES, PET_NAMES, shareLine, stackFrames, takeLine, trawlLine } from '@fleet/kit/family.js';

const firstLine = (s) => String(s ?? '').split('\n')[0].trim();
const bare = (ref) => String(ref ?? '').replace(/^refs\/heads\//, '');

/** A pull request as the family's `pullrequest` context (no secrets: names, branches and its link). */
export function prContext(pr) {
  return {
    ...(pr.org ? { org: pr.org } : {}),
    ...(pr.projectName ? { project: pr.projectName } : {}),
    repo: pr.repoName,
    id: pr.id,
    title: pr.title,
    sourceBranch: bare(pr.sourceBranch),
    targetBranch: bare(pr.targetBranch),
    ...(pr.webUrl ? { url: pr.webUrl } : {}),
  };
}

// What a source file in an error line looks like: its extension is one code is written in, so a host and
// port ("example.com:443") or a version ("1.2.3") never counts as one.
const SOURCE = 'js|jsx|mjs|cjs|ts|tsx|vue|svelte|cs|fs|vb|razor|cshtml|py|java|kt|kts|scala|go|rb|php|rs|c|cc|cpp|h|hpp|swift|sql|ps1|psm1|sh|yml|yaml|json|xml|csproj|props|targets|tf|bicep';
const PLACE = new RegExp(`(?:^|[\\s'"(\\[=])((?:[A-Za-z]:)?[\\\\/]?(?:[\\w.@-]+[\\\\/])*[\\w.@-]+\\.(?:${SOURCE}))(?::(\\d+)(?::\\d+)?|\\((\\d+)(?:,\\d+)*\\)|:line (\\d+))`, 'i');

/**
 * A path as a checkout has it: the build agent's working folder taken off the front (Azure Pipelines'
 * D:\a\1\s\, /home/vsts/work/1/s/, /__w/1/s/; GitHub Actions' /home/runner/work/<repo>/<repo>/), / between
 * folders. Anything else is left for Splice to match by its tail.
 */
export function sourcePath(p) {
  return String(p ?? '')
    .replace(/\\/g, '/')
    .replace(/^(?:[A-Za-z]:)?\/(?:.*?\/)?(?:a|work|_work|__w)\/\d+\/s\//, '')
    .replace(/^(?:[A-Za-z]:)?\/(?:home\/runner\/work|a)\/[^/]+\/[^/]+\//, '');
}

/** The first file and line a piece of text names: a stack frame, `path:line`, `path(line,col)`; null when none. */
export function placeIn(text) {
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const frame = stackFrames(line)[0];
    if (frame) return { path: sourcePath(frame.file), line: frame.line };
    const m = PLACE.exec(line);
    if (m && !/node_modules/.test(m[1])) return { path: sourcePath(m[1]), line: Number(m[2] ?? m[3] ?? m[4]) };
  }
  return null;
}

/**
 * Where a failed run (service.runDetails) points in the code: { step, message, path?, line? }, from its
 * failed steps' errors first, then their logs' lines that say error or fail, then the rest of those logs;
 * null when nothing failed.
 */
export function failureOf(details) {
  const failed = (details?.timeline ?? []).filter((r) => r.result === 'failed');
  if (!failed.length) return null;
  const task = failed.find((r) => r.type === 'Task') ?? failed.at(-1);
  const errors = failed.flatMap((r) => (r.issues ?? []).filter((i) => i.type === 'error').map((i) => i.message));
  const logs = failed.flatMap((r) => String(details.logs?.[r.id] ?? '').replace(/\r/g, '').split('\n').filter((l) => l.trim()));
  const loud = logs.filter((l) => /error|fail|assert|exception/i.test(l));
  for (const text of [...errors, ...loud, ...logs]) {
    const place = placeIn(text);
    if (place) return { step: task.name, message: firstLine(text).slice(0, 200), ...place };
  }
  return { step: task.name, message: firstLine(errors[0] ?? loud.at(-1) ?? '').slice(0, 200) };
}

/**
 * What alt+y on a run hands Splice: `/take file` at the place its failure names when there is one, else
 * `/take commit` of the commit it built (subject from the run's commits). null when it has neither.
 */
export function runForSplice(row, run, details) {
  const failure = failureOf(details);
  if (failure?.path) return { line: takeLine('file', { path: failure.path, ...(failure.line ? { line: failure.line } : {}) }), failure };
  if (!run?.commit) return null;
  const change = (details?.changes ?? []).find((c) => String(c.id).toLowerCase() === String(run.commit).toLowerCase());
  const subject = firstLine(change?.message) || `${row.definition.name} ${run.buildNumber}${failure ? ` failed at ${failure.step}` : ''}`;
  return { line: takeLine('commit', { ...(row.repoName ? { repo: row.repoName } : {}), hash: run.commit, subject }), failure };
}

/** Whether a pipeline deploys: a production monitor is linked to it, or its name says so. */
export function deploys(row, monitors = []) {
  const key = `pipeline:${row.projectId}:${row.definition.id}`;
  return monitors.some((m) => m.targetKey === key) || /deploy|release|\bprod|\bcd\b/i.test(row.definition.name);
}

/** An ISO time to the second, as Sonar's /compare-window takes it. */
const isoTime = (at) => new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * alt+k on a production monitor: the deploy its "failures up since …" issue names (or "404s up since …"),
 * else its latest deploy, as { deploy, issue, line } with Sonar's `/compare-window <time>` line; null when
 * it has had no deploy Keel knows of.
 */
export function compareForSonar(m) {
  const issue = (m.issues ?? []).find((i) => i.deploy?.at && i.code === 'deploy-regression') ?? (m.issues ?? []).find((i) => i.deploy?.at);
  const deploy = issue?.deploy ?? (m.markers ?? []).find((d) => d.at);
  if (!deploy || !Number.isFinite(Date.parse(deploy.at))) return null;
  return { deploy, issue: issue ?? null, line: shareLine('compare-window', [isoTime(deploy.at)]) };
}

/**
 * /family: what the folder Keel was started in (family.js projectAt) offers the others, as lines for their
 * prompts: [{ app, line, what }]. Splice opens the checkout, Bosun runs the project, Hail opens each .http
 * file, Trawl each database its settings name (never a password).
 */
export function familyChoices(p) {
  const out = [];
  if (p.repo) out.push({ app: 'splice', line: shareLine('open', [p.repo]), what: `the checkout ${p.repo}` });
  if (p.crew) out.push({ app: 'bosun', line: shareLine('move', [p.dir]), what: `run ${p.dir}` });
  for (const f of p.httpFiles ?? []) out.push({ app: 'hail', line: shareLine('open', [f]), what: relative(p.dir, f).replace(/\\/g, '/') });
  for (const d of p.databases ?? []) out.push({ app: 'trawl', line: trawlLine(d, d.name), what: `${d.name} from ${d.source}: ${d.server}${d.database ? `/${d.database}` : ''}` });
  return out;
}

const key = (x) => `${x.org ?? ''}/${x.key}`;

/** The pipelines failing now that weren't at the read before (`prev` null on the first read: nothing has started then). */
export function newlyFailing(prev, now) {
  if (!prev || !now) return [];
  const was = new Set(prev.filter((r) => r.health === 'failing').map(key));
  return now.filter((r) => r.health === 'failing' && !was.has(key(r)));
}

/** Your pull requests that were active at the read before and aren't now (completed or abandoned). */
export function mineGone(prev, now) {
  if (!prev || !now) return [];
  const still = new Set(now.map(key));
  return prev.filter((p) => p.isMine && !still.has(key(p)));
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * How Pinch feels, for the family (family.js writeMood): { mood, reason }, mood one of worried, busy, happy
 * or neutral. Worried while a production monitor is down or a pipeline started failing lately (`alarm`),
 * busy while Keel reads or acts, happy for a while after your pull request merged (`merged`), else watching.
 */
export function familyMood({ data = {}, busy, alarm, merged } = {}) {
  const down = (data.production?.monitors ?? []).filter((m) => m.state === 'down');
  if (down.length) return { mood: 'worried', reason: `${down[0].name} is down${down.length > 1 ? ` (and ${down.length - 1} more)` : ''}` };
  if (alarm) return { mood: 'worried', reason: alarm };
  if (busy) return { mood: 'busy', reason: firstLine(busy.label) || 'working' };
  if (merged) return { mood: 'happy', reason: merged };
  if (!data.pipelines || !data.prs) return { mood: 'busy', reason: 'reading Azure DevOps' };
  const failing = data.pipelines.filter((r) => r.health === 'failing').length;
  return { mood: 'neutral', reason: `watching ${plural(data.prs.length, 'pull request')} and ${plural(data.pipelines.length, 'pipeline')}${failing ? `, ${failing} failing` : ''}` };
}

/** The moods worth a word from Pinch (readMoods' list, newest first): the newest worried, sad or happy one not yet `seen` (keys from moodKey). */
export const moodKey = (m) => `${m.app}|${m.at}`;
export const reactionTo = (moods, seen) => moods.find((m) => ['worried', 'sad', 'happy'].includes(m.mood) && m.reason && !seen.has(moodKey(m))) ?? null;

/** The line Pinch shows for a sibling's mood: "Twig says: PR #12 merged". */
export const reactionLine = (m) => `${PET_NAMES[m.app] ?? APP_NAMES[m.app] ?? m.app} says: ${m.reason}`;

/** /timeline as the viewer's text: the family's activity log (family.js readActivity), newest first. */
export function timelineText(entries, now = Date.now()) {
  if (!entries.length) return 'Nothing logged yet: the apps add what they change (a push, a restart, a write to a database, a vote) as they do it.';
  const appW = Math.max(...entries.map((e) => (APP_NAMES[e.app] ?? e.app).length));
  const when = (at) => {
    const s = Math.max(0, Math.round((now - at) / 1000));
    return s < 60 ? 'now' : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
  };
  const base = (p) => String(p ?? '').split(/[\\/]/).filter(Boolean).pop() ?? '';
  return entries.map((e) => `${when(e.at).padStart(4)}  ${(APP_NAMES[e.app] ?? e.app).padEnd(appW)}  ${e.text}${e.project ? `  (${base(e.project)})` : ''}`).join('\n');
}
