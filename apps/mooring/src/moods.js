// Tug's mood for the family (family.js's writeMood and readMoods): what Mooring says about itself, and
// what Tug says when a sibling's mascot is worried, sad or happy. Pure. A reason names transfers and
// hosts by the names saved here, never a path on a server, a key or a password.
import { APP_NAMES } from '@fleet/kit/family.js';
import { PET } from './pet.js';

const names = (list, name) => (list.length <= 2 ? list.map(name).join(', ') : `${list.slice(0, 2).map(name).join(', ')} and ${list.length - 2} more`);

/**
 * The family's word for how Tug feels (happy | worried | busy | neutral) and why: a transfer that failed
 * or a connection that didn't open, worried; a transfer or command running, busy; a result just now, happy.
 */
export function familyMood({ mood, trouble, lastEntry, busy, host }) {
  if (trouble?.failed.length) return { mood: 'worried', reason: `${names(trouble.failed, (t) => t.name)} didn't transfer` };
  if (trouble?.problem) return { mood: 'worried', reason: `couldn't connect: ${String(trouble.problem).split('\n')[0]}`.slice(0, 100) };
  if (mood === 'worried') return { mood: 'worried', reason: String(lastEntry?.title ?? 'something went wrong').slice(0, 100) };
  if (mood === 'look') return { mood: 'busy', reason: busy?.label ?? 'transferring' };
  if (mood === 'happy') return { mood: 'happy', reason: String(lastEntry?.title ?? 'that went well').slice(0, 100) };
  if (mood === 'wave') return { mood: 'happy', reason: `connected to ${host}` };
  return { mood: 'neutral', reason: 'not connected' };
}

const SAYS = {
  worried: (app, why) => `${PET.name} tightens the line: ${app} is worried${why}.`,
  sad: (app, why) => `${PET.name} lets the line go slack: ${app} is sad${why}.`,
  happy: (app, why) => `${PET.name} claps its paws: ${app} is happy${why}.`,
};

/** The newest of the siblings' `moods` worth a word from Tug (worried, sad or happy) that isn't in `seen` (keys app:at), or null. */
export function reactionTo(moods, seen = new Set()) {
  const m = moods.find((x) => SAYS[x.mood] && !seen.has(`${x.app}:${x.at}`));
  if (!m) return null;
  return { key: `${m.app}:${m.at}`, mood: m.mood, text: SAYS[m.mood](APP_NAMES[m.app] ?? m.app, m.reason ? ` (${String(m.reason).slice(0, 80)})` : '') };
}
