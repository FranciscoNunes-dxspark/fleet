// What Sonar itself does with the family (family.js, shared by all five apps, has the rest): the
// siblings' names and mascots, the line said when something is copied for one, what /family offers,
// Ping's mood in the family's words and its word on theirs, and what counts as a paste. Pure.
import { relative } from 'node:path';
import { contextIn, decodeContext, describeContext, shareLine } from './family.js';

/** The apps as their names are written. */
export const APP_NAMES = { splice: 'Splice', trawl: 'Trawl', sonar: 'Sonar', bosun: 'Bosun', hail: 'Hail' };

/** The siblings' mascots, as they sign their moods. */
export const PET_NAMES = { splice: 'Twig', trawl: 'Glim', sonar: 'Ping', bosun: 'Squawk', hail: 'Hoot' };

/** The log line for `line` copied for `app`: what to do with it, then the line (or, for a /take, what it holds). */
export function copiedNote(app, line) {
  const name = APP_NAMES[app] ?? app;
  const context = contextIn(line);
  return `Copied for ${name}: paste it into ${name}'s prompt\n${context ? describeContext(context) : line}`;
}

/** What a database from a project's settings is in Trawl's prompt: /azure-sql for Azure SQL, else /add. Never a password. */
export function trawlLine(db) {
  if (/\.database\.windows\.net$/i.test(db.server)) return shareLine('azure-sql', [db.server, ...(db.database ? [db.database] : [])]);
  const server = db.kind === 'sqlserver' && db.port && db.port !== 1433 ? `${db.server},${db.port}` : db.server;
  return shareLine('add', [db.name, server, ...(db.database ? [db.database] : []), ...(db.kind !== 'sqlserver' ? ['--kind', db.kind] : []), ...(db.user ? ['--user', db.user] : [])]);
}

/**
 * /family: what the project in `p` (family.js projectAt) offers the siblings, as lines for their prompts:
 * [{ app, line, what }]. Splice opens the checkout, Bosun runs the project, Hail opens each .http file,
 * Trawl each database its settings name.
 */
export function familyChoices(p) {
  const out = [];
  if (p.repo) out.push({ app: 'splice', line: shareLine('open', [p.repo]), what: `the checkout ${p.repo}` });
  if (p.crew) out.push({ app: 'bosun', line: shareLine('move', [p.dir]), what: `run ${p.dir}` });
  for (const f of p.httpFiles ?? []) out.push({ app: 'hail', line: shareLine('open', [f]), what: relative(p.dir, f).replace(/\\/g, '/') });
  for (const d of p.databases ?? []) out.push({ app: 'trawl', line: trawlLine(d), what: `${d.name} from ${d.source}: ${d.server}${d.database ? `/${d.database}` : ''}` });
  return out;
}

/**
 * How Ping feels, for the family (family.js writeMood): { mood, reason }, mood one of happy, worried,
 * busy or neutral, from the pet's own (pet.js moodFor) and what it's about.
 */
export function familyMood(petMood, { busy, lastEntry, data } = {}) {
  const said = (t) => String(t ?? '').split('\n')[0].slice(0, 100);
  if (petMood === 'worried') return { mood: 'worried', reason: said(lastEntry?.title) || 'something went wrong' };
  if (petMood === 'look') return { mood: 'busy', reason: said(busy?.label) || 'working' };
  if (petMood === 'happy') return { mood: 'happy', reason: said(lastEntry?.title) || 'done' };
  if (!data) return { mood: 'neutral', reason: 'reading the subscription' };
  return { mood: 'neutral', reason: `watching ${data.apps.length} app${data.apps.length === 1 ? '' : 's'} in ${data.subscription.name}` };
}

/** The moods worth a word from Ping (readMoods' list, newest first): the newest worried, sad or happy one not yet `seen` (keys from moodKey). */
export const moodKey = (m) => `${m.app}|${m.at}`;
export const reactionTo = (moods, seen) => moods.find((m) => ['worried', 'sad', 'happy'].includes(m.mood) && m.reason && !seen.has(moodKey(m))) ?? null;

/** The line Ping shows for a sibling's mood: "Twig says: PR #12 merged". */
export const reactionLine = (m) => `${PET_NAMES[m.app] ?? APP_NAMES[m.app] ?? m.app} says: ${m.reason}`;

/**
 * Text that arrived at once while a view had the keys, as a paste does: the line to put in the prompt
 * when it's a command (starts with /) or a sibling's context on its own; else null (keys as usual).
 */
export function pastedLine(input) {
  const s = String(input ?? '').replace(/\x1b\[20[01]~/g, '').replace(/[\r\n]+$/, '');
  if (s.length < 2 || /[\r\n]/.test(s)) return null;
  return s.startsWith('/') || decodeContext(s) ? s.trim() : null;
}
