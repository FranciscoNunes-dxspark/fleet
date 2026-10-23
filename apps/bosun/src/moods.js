// Squawk's mood for the family (family.js's writeMood and readMoods): what Bosun says about itself,
// and what Squawk says when a sibling's mascot is worried, sad or happy. Pure.
import { PET } from './pet.js';

const APPS = { splice: 'Splice', trawl: 'Trawl', sonar: 'Sonar', bosun: 'Bosun', hail: 'Hail' };
export const appName = (app) => APPS[app] ?? app;
const names = (ps) => (ps.length <= 3 ? ps.map((p) => p.name).join(', ') : `${ps.slice(0, 2).map((p) => p.name).join(', ')} and ${ps.length - 2} more`);

/**
 * The family's word for how Squawk feels (happy | worried | sad | busy | neutral) and why, from its
 * pet.js mood and the crew: one that gave up is sad; a crash, failing tests or an error just said,
 * worried; a command running, busy; a crew all up (or a result just now), happy; else neutral.
 */
export function familyMood({ mood, data, lastEntry, busy }) {
  const procs = data?.procs ?? [];
  const gaveUp = procs.filter((p) => p.gaveUp && !p.child);
  if (gaveUp.length) return { mood: 'sad', reason: `${names(gaveUp)} gave up restarting` };
  const crashed = procs.filter((p) => p.status === 'crashed');
  if (crashed.length) return { mood: 'worried', reason: `${names(crashed)} crashed` };
  const failing = procs.filter((p) => p.tests?.state === 'failed');
  if (failing.length) return { mood: 'worried', reason: `${names(failing)}: Hail's checks failed` };
  if (mood === 'worried') return { mood: 'worried', reason: lastEntry?.title ?? 'something went wrong' };
  if (mood === 'look') return { mood: 'busy', reason: busy?.label ?? 'working' };
  if (mood === 'happy') return { mood: 'happy', reason: lastEntry?.title ?? 'that went well' };
  if (mood === 'wave') {
    const up = procs.filter((p) => p.child).length;
    return { mood: 'happy', reason: up === procs.length ? `all ${procs.length} running` : `${up} of ${procs.length} running` };
  }
  return { mood: 'neutral', reason: procs.length ? 'nothing running' : 'nothing to run' };
}

const SAYS = {
  worried: (app, why) => `${PET.name} ruffles its feathers: ${app} is worried${why}.`,
  sad: (app, why) => `${PET.name} leans in close: ${app} is sad${why}.`,
  happy: (app, why) => `${PET.name} whistles along: ${app} is happy${why}.`,
};

/** The newest of the siblings' `moods` worth a word from Squawk (worried, sad or happy) that isn't in `seen` (keys app:at), or null. */
export function reactionTo(moods, seen = new Set()) {
  const m = moods.find((x) => SAYS[x.mood] && !seen.has(`${x.app}:${x.at}`));
  if (!m) return null;
  return { key: `${m.app}:${m.at}`, mood: m.mood, text: SAYS[m.mood](appName(m.app), m.reason ? ` (${String(m.reason).slice(0, 80)})` : '') };
}
