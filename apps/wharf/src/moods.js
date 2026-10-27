// Bark's mood for the family (family.js's writeMood and readMoods): what Wharf says about itself, and
// what Bark says when a sibling's mascot is worried, sad or happy. Pure.
import { APP_NAMES } from '@fleet/kit/family.js';
import { PET } from './pet.js';

const names = (list) => (list.length <= 3 ? list.map((c) => c.name).join(', ') : `${list.slice(0, 2).map((c) => c.name).join(', ')} and ${list.length - 2} more`);

/**
 * The family's word for how Bark feels (happy | worried | sad | busy | neutral) and why, from its
 * pet.js mood and what Docker and the cluster hold: a container that exited with an error or is
 * unhealthy, or a crash-looping pod, worried; a command running, busy; a result just now, or
 * everything running, happy; else neutral.
 */
export function familyMood({ mood, data, kubeData, lastEntry, busy }) {
  const boxes = data?.containers ?? [];
  const crashed = boxes.filter((c) => (c.state === 'exited' && c.exitCode > 0) || c.state === 'dead');
  if (crashed.length) return { mood: 'worried', reason: `${names(crashed)} exited with an error` };
  const unwell = boxes.filter((c) => c.health === 'unhealthy');
  if (unwell.length) return { mood: 'worried', reason: `${names(unwell)} unhealthy` };
  const loops = (kubeData?.pods ?? []).filter((p) => ['CrashLoopBackOff', 'ImagePullBackOff', 'ErrImagePull', 'OOMKilled', 'Error'].includes(p.status));
  if (loops.length) return { mood: 'worried', reason: `${names(loops)}: ${loops[0].status}` };
  if (mood === 'worried') return { mood: 'worried', reason: lastEntry?.title ?? 'something went wrong' };
  if (mood === 'look') return { mood: 'busy', reason: busy?.label ?? 'working' };
  if (mood === 'happy') return { mood: 'happy', reason: lastEntry?.title ?? 'that went well' };
  if (mood === 'wave') {
    const up = boxes.filter((c) => c.state === 'running').length;
    return { mood: 'happy', reason: up === boxes.length ? `all ${boxes.length} running` : `${up} of ${boxes.length} running` };
  }
  return { mood: 'neutral', reason: boxes.length ? 'nothing running' : 'no containers' };
}

const SAYS = {
  worried: (app, why) => `${PET.name} pricks up its whiskers: ${app} is worried${why}.`,
  sad: (app, why) => `${PET.name} nudges the container along: ${app} is sad${why}.`,
  happy: (app, why) => `${PET.name} claps its flippers: ${app} is happy${why}.`,
};

/** The newest of the siblings' `moods` worth a word from Bark (worried, sad or happy) that isn't in `seen` (keys app:at), or null. */
export function reactionTo(moods, seen = new Set()) {
  const m = moods.find((x) => SAYS[x.mood] && !seen.has(`${x.app}:${x.at}`));
  if (!m) return null;
  return { key: `${m.app}:${m.at}`, mood: m.mood, text: SAYS[m.mood](APP_NAMES[m.app] ?? m.app, m.reason ? ` (${String(m.reason).slice(0, 80)})` : '') };
}
