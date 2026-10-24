// What Sonar itself does with the family (family.js, shared by all five apps, has the rest: the names,
// who takes what, the paste rule, the copied note and Trawl's lines): what /family offers, and Ping's
// mood in the family's words and its word on theirs. Pure.
import { relative } from 'node:path';
import { APP_NAMES, PET_NAMES, shareLine, trawlLine } from '@fleet/kit/family.js';

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
  for (const d of p.databases ?? []) out.push({ app: 'trawl', line: trawlLine(d, d.name), what: `${d.name} from ${d.source}: ${d.server}${d.database ? `/${d.database}` : ''}` });
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
