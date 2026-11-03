// Plod's mood for the family (family.js's writeMood and readMoods): what Ballast says about itself,
// and what Plod says when a sibling's mascot is worried, sad or happy. Pure.
import { APP_NAMES } from '@fleet/kit/family.js';
import { formatBytes } from './sizes.js';
import { PET } from './pet.js';

/**
 * The family's word for how Plod feels (happy | worried | sad | busy | neutral) and why: a file over its
 * budget, worried; a command running, busy; a build within its budgets, or a result just now, happy;
 * else neutral. Only sizes and file names: nothing from inside the bundle.
 */
export function familyMood({ mood, build, over = [], budgeted = false, total = null, measure = 'gzip', lastEntry, busy }) {
  if (over.length) return { mood: 'worried', reason: `${over.length} over budget: ${over[0].pattern} ${formatBytes(over[0].size)} > ${formatBytes(over[0].limit)}` };
  if (mood === 'worried') return { mood: 'worried', reason: lastEntry?.title ?? 'something went wrong' };
  if (mood === 'look') return { mood: 'busy', reason: busy?.label ?? 'working' };
  if (mood === 'happy') return { mood: 'happy', reason: lastEntry?.title ?? 'that went well' };
  if (build?.chunks?.length) return { mood: 'happy', reason: `${formatBytes(total)} ${measure}${budgeted ? ', within its budgets' : ''}` };
  return { mood: 'neutral', reason: 'no build read' };
}

const SAYS = {
  worried: (app, why) => `${PET.name} pulls its head in: ${app} is worried${why}.`,
  sad: (app, why) => `${PET.name} plods on, slower: ${app} is sad${why}.`,
  happy: (app, why) => `${PET.name} stretches its neck: ${app} is happy${why}.`,
};

/** The newest of the siblings' `moods` worth a word from Plod (worried, sad or happy) that isn't in `seen` (keys app:at), or null. */
export function reactionTo(moods, seen = new Set()) {
  const m = moods.find((x) => SAYS[x.mood] && !seen.has(`${x.app}:${x.at}`));
  if (!m) return null;
  return { key: `${m.app}:${m.at}`, mood: m.mood, text: SAYS[m.mood](APP_NAMES[m.app] ?? m.app, m.reason ? ` (${String(m.reason).slice(0, 80)})` : '') };
}
