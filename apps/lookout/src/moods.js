// Peep's mood for the family (family.js's writeMood and readMoods): what Lookout says about itself, and
// what Peep says when a sibling's mascot is worried, sad or happy. Nothing captured goes into a mood:
// counts and the port only, never a URL, a header or a body. Pure.
import { APP_NAMES } from '@fleet/kit/family.js';
import { PET } from './pet.js';

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/**
 * The family's word for how Peep feels (happy | worried | busy | neutral) and why: a high finding or a
 * refused handshake, worried; requests in flight, busy; a result just now or traffic seen, happy.
 */
export function familyMood({ mood, state = {}, lastEntry }) {
  if (state.serious) return { mood: 'worried', reason: `${plural(state.serious, 'serious finding')} in captured traffic` };
  if (state.refused) return { mood: 'worried', reason: `${plural(state.refused, 'client')} refused the certificate` };
  if (mood === 'worried') return { mood: 'worried', reason: lastEntry?.title ?? 'something went wrong' };
  if (mood === 'look') return { mood: 'busy', reason: `capturing on port ${state.port}` };
  if (mood === 'happy') return { mood: 'happy', reason: lastEntry?.title ?? 'that went well' };
  if (state.listening) return { mood: state.count ? 'happy' : 'neutral', reason: state.count ? `${plural(state.count, 'request')} captured` : `listening on port ${state.port}` };
  return { mood: 'neutral', reason: 'not listening' };
}

const SAYS = {
  worried: (app, why) => `${PET.name} stands up straight and stares: ${app} is worried${why}.`,
  sad: (app, why) => `${PET.name} edges closer: ${app} is sad${why}.`,
  happy: (app, why) => `${PET.name} chirps: ${app} is happy${why}.`,
};

/** The newest of the siblings' `moods` worth a word from Peep (worried, sad or happy) that isn't in `seen` (keys app:at), or null. */
export function reactionTo(moods, seen = new Set()) {
  const m = moods.find((x) => SAYS[x.mood] && !seen.has(`${x.app}:${x.at}`));
  if (!m) return null;
  return { key: `${m.app}:${m.at}`, mood: m.mood, text: SAYS[m.mood](APP_NAMES[m.app] ?? m.app, m.reason ? ` (${String(m.reason).slice(0, 80)})` : '') };
}
