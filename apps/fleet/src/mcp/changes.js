// What changed lately in a project, as one timeline: the family's activity log (pushes, writes,
// restarts, environment switches), the repository's commits and merges (Splice's git, as git.js reads
// it), and the crashes and restarts in Bosun's recordings (as bosun.js reads them), newest first; with
// the apps' worried moods on top as the symptoms it might explain. Fleet's panel (the prefix and w)
// shows it and can ask Claude to rank the likely causes; `fleet mcp` serves it as `what_changed`.
// Everything here only reads.
import { APP_NAMES, familyDir as kitFamilyDir, readActivity, readMoods, repoRoot } from '@fleet/kit/family.js';
import { ALERT_MOODS } from '../attention.js';
import { bosunHome } from '../trace.js';
import { count, line, stamp } from './bound.js';
import { crewEvents } from './bosun.js';
import { recentCommits } from './git.js';

const HOUR = 60 * 60_000;
/** The windows the panel steps through, in hours. */
export const WINDOWS = [1, 6, 24];
const MAX_EVENTS = 300;
// A mood older than this isn't "now": the apps write theirs as it changes, and readMoods' default too.
const MOOD_AGE = 15 * 60_000;

// setEnvironment's own words in the activity log (the kit's environments.js).
const SWITCH = /^Switched .+ to \S+/;

/**
 * The timeline of `project` for the last `hours`: { project, since, now, hours, symptoms, events,
 * notes }. `symptoms` are the worried (or sad) moods ({ app, mood, reason, at }); `events` are { at,
 * app, source ('activity', 'environment', 'git', 'bosun'), kind, text }, newest first, at most 300;
 * `notes` say what couldn't be read. `familyDir` and `bosun` (Bosun's folder) are injected for tests.
 */
export async function whatChanged({ project = process.cwd(), hours = 6, now = Date.now(), familyDir = kitFamilyDir(), bosun = bosunHome() } = {}) {
  const since = now - hours * HOUR;
  const notes = [];
  const events = [];
  for (const e of readActivity({ dir: familyDir, since, project, limit: 2000 })) {
    const text = String(e.text ?? '');
    events.push({ at: e.at, app: e.app, source: SWITCH.test(text) ? 'environment' : 'activity', kind: e.kind ?? 'info', text });
  }
  const root = repoRoot(project);
  if (root) {
    try {
      for (const c of await recentCommits(root, since)) events.push({ at: c.at, app: 'splice', source: 'git', kind: c.merge ? 'merge' : 'commit', text: `${c.merge ? 'merge ' : ''}${c.hash.slice(0, 7)} ${c.subject} (${c.author})` });
    } catch (e) {
      notes.push(`git: ${String(e.message).split('\n')[0]}`);
    }
  }
  try {
    for (const c of await crewEvents(project, { since, home: bosun })) events.push({ ...c, source: 'bosun', kind: /crashed|gave up/.test(c.text) ? 'crash' : 'restart' });
  } catch (e) {
    notes.push(`Bosun's recordings: ${String(e.message).split('\n')[0]}`);
  }
  events.sort((a, b) => b.at - a.at);
  const symptoms = readMoods(null, { dir: familyDir, now, maxAge: MOOD_AGE }).filter((m) => ALERT_MOODS.has(m.mood));
  return { project, since, now, hours, symptoms, events: events.slice(0, MAX_EVENTS), notes };
}

// Fleet logs too (its environment switches), and isn't one of the family's apps.
const nameOf = (app) => APP_NAMES[app] ?? (app === 'fleet' ? 'Fleet' : app);

/** What a symptom says, in a sentence: "Bosun is worried: api crashed". */
export const symptomText = (m) => `${nameOf(m.app)} is ${m.mood}${m.reason ? `: ${m.reason}` : ''}`;

/** The timeline as text, for Claude and for `what_changed`: the symptoms, then every event, newest first. */
export function timelineText(result, { limit = MAX_EVENTS } = {}) {
  const { project, since, now, hours, symptoms, events, notes } = result;
  const out = [`What changed in ${project} in the last ${hours} hour${hours === 1 ? '' : 's'} (${stamp(since)} to ${stamp(now)} UTC), newest first.`, ''];
  out.push(symptoms.length ? 'Symptoms now (the apps that are worried):' : 'Symptoms now: none (no app is worried).');
  for (const m of symptoms) out.push(`  ${symptomText(m)}  (since ${stamp(m.at)})`);
  out.push('', events.length ? `Timeline (${events.length}${events.length > limit ? `, the newest ${limit}` : ''}):` : 'Timeline: nothing changed in that time (the activity log, git and Bosun).');
  for (const e of events.slice(0, limit)) out.push(`  ${stamp(e.at)}  ${nameOf(e.app).padEnd(7)}  ${e.source.padEnd(11)}  ${e.kind !== 'info' ? `[${e.kind}] ` : ''}${line(e.text, 300)}`);
  if (notes.length) out.push('', 'Not read:', ...notes.map((n) => `  ${n}`));
  return out.join('\n');
}

/** What to ask Claude for the likely causes of `symptom`, the timeline on standard input. */
export function causesPrompt(symptom) {
  return [
    `Something is wrong in a software project: ${symptom}`,
    'Standard input has what changed in the project lately, newest first: the activity log of the developer tools in use (pushes, database writes, restarts, environment switches, deployments), git commits and merges, and crashes and restarts of its local processes, with the symptoms the tools report now at the top.',
    'Rank the most likely causes of the symptom, most likely first (at most five). For each: the cause in one sentence, the timeline entries that point to it (their time and what they say), how sure you are, and what to check to confirm it.',
    'Go only by what the timeline says; where nothing in it explains the symptom, say so plainly rather than guessing.',
    'Plain text for a terminal panel about 90 columns wide: a numbered list, no tables, no headings, no introduction.',
  ].join('\n');
}

export const changeTools = [
  {
    name: 'what_changed',
    description:
      "What changed in the project lately, as one timeline, newest first: the family's activity log (pushes, database writes, restarts, environment switches), the repository's commits and merges, and crashes and restarts in Bosun's recordings, with the apps' worried moods on top as the symptoms now. For \"it broke, what changed?\". Read only; secrets masked.",
    inputSchema: { type: 'object', properties: { hours: { type: 'integer', description: 'How far back, in hours (default 6, at most 168)' } } },
    annotations: { openWorldHint: false },
    async run({ hours }, ctx) {
      return timelineText(await whatChanged({ project: ctx.project, hours: count(hours, 6, 168) }));
    },
  },
];
