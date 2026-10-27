// Which app off screen needs you, from what the family's apps write to their shared folder (the kit's
// family.js, ~/.family or FAMILY_HOME): each app's mood, `<app>.mood.json`, and the activity log,
// `activity.jsonl`. A space is keyed by its id, which is the name its app writes under, so an app that
// starts writing a mood (Keel's terminal app) is read like the others with nothing said about it here.
//
// The host reads the folder every few seconds (`familyReader`, which reads a file again only when it
// changed) and `badgeFor`, pure, says what a tab shows: `!` while the app's mood is worried or sad and
// became so after you last looked at that space, and how many alerting entries (a crash, a failing
// watch, an error) it logged since. Moods and entries from before you last looked never count.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { familyDir } from '@fleet/kit/family.js';

/** The moods that mean trouble: Bosun's crashes and give-ups, Sonar's and Hail's failures, Wharf's exited containers. */
export const ALERT_MOODS = new Set(['worried', 'sad']);

/**
 * The activity kinds worth a badge. The apps log most of what they do as info or a change (a push, a
 * backup); Sonar's watches log `alert` and Bosun's crashes `error`; the rest are names an app may use.
 */
export const ALERT_KINDS = new Set(['alert', 'error', 'crash', 'failed', 'failure', 'warning']);

/** How many entries a badge counts before it says "9+". */
const MAX_COUNT = 9;

/**
 * A tab's badge for space `id`, pure: { alert, count, reason, text } or null for none. `mood` is the
 * app's last mood ({ mood, reason, at }) or null, `activity` the family's entries (any order), `seen`
 * when you last looked at the space (ms).
 */
export function badgeFor(id, { mood, activity = [], seen = 0 }) {
  const alert = Boolean(mood && ALERT_MOODS.has(mood.mood) && Number(mood.at) > seen);
  const entries = activity.filter((e) => e?.app === id && ALERT_KINDS.has(e.kind) && Number(e.at) > seen).sort((a, b) => b.at - a.at);
  if (!alert && !entries.length) return null;
  const count = entries.length;
  const reason = alert ? String(mood.reason ?? '') : String(entries[0].text ?? '');
  return { alert, count, reason, text: badgeText({ alert, count }) };
}

/** What the tab writes for a badge: "!", "3", "!3", "!9+". */
export const badgeText = (badge) => (badge ? `${badge.alert ? '!' : ''}${badge.count ? (badge.count > MAX_COUNT ? `${MAX_COUNT}+` : badge.count) : ''}` : '');

/** Whether badge `next` is news beside `prev`: there was none, or it says more (the bell, the notice). */
export const isNews = (prev, next) => Boolean(next && (!prev || (next.alert && !prev.alert) || next.count > prev.count));

/**
 * A reader of the family's folder `dir` that reads each file again only when its size or time changed:
 * read(ids) → { moods: { id: mood | null }, activity: [entries] }. Nothing it reads can throw.
 */
export function familyReader(dir = familyDir()) {
  const cache = new Map();
  const readIfChanged = (file, parse) => {
    let stat;
    try {
      stat = statSync(file);
    } catch {
      cache.delete(file);
      return parse(null);
    }
    const key = `${stat.size}:${stat.mtimeMs}`;
    const kept = cache.get(file);
    if (kept?.key === key) return kept.value;
    let value;
    try {
      value = parse(readFileSync(file, 'utf8'));
    } catch {
      value = parse(null);
    }
    cache.set(file, { key, value });
    return value;
  };
  const mood = (text) => {
    if (!text) return null;
    const m = JSON.parse(text);
    return m && typeof m === 'object' ? m : null;
  };
  const activity = (text) => {
    if (!text) return [];
    // Only the end matters (what happened since you last looked), so the last lines are enough.
    const lines = text.split('\n').slice(-400);
    const out = [];
    for (const line of lines) {
      if (!line) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // A line cut while it was written, or not JSON: skipped.
      }
    }
    return out;
  };
  return {
    dir,
    read(ids) {
      const moods = {};
      for (const id of ids) moods[id] = readIfChanged(join(dir, `${id}.mood.json`), mood);
      return { moods, activity: readIfChanged(join(dir, 'activity.jsonl'), activity) };
    },
  };
}
