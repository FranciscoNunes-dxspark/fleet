// What every tool's answer goes through before it reaches Claude: secrets masked (the family's rule,
// the kit's redactSecrets) and the size bounded, so one big log or diff can't flood the context.
import { redactSecrets } from '@fleet/kit/family.js';

/** The most any one answer holds, in characters. */
export const MAX_TEXT = 40_000;

/** `text` cut to `max` characters at a line's end where one is near, saying how much was left out. */
export function clip(text, max = MAX_TEXT) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  let cut = s.lastIndexOf('\n', max);
  if (cut < max * 0.8) cut = max;
  return `${s.slice(0, cut)}\n… (cut: ${s.length - cut} more characters; ask for less)`;
}

/** The end of `text`, at most `max` characters, from a whole line: for logs, where the newest is last. */
export function tail(text, max = MAX_TEXT) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  const from = s.indexOf('\n', s.length - max);
  return `… (${from + 1} earlier characters left out)\n${s.slice(from < 0 ? s.length - max : from + 1)}`;
}

/** An answer as it may leave: secrets masked, then bounded. */
export const finish = (text, max = MAX_TEXT) => clip(redactSecrets(text), max);

/** A count from a tool's arguments: a whole number from 1 to `max`, else `fallback`. */
export function count(value, fallback, max) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, max) : fallback;
}

/** One line of a list, long ones cut: what a table cell or a log line may take. */
export const line = (text, max = 400) => {
  const s = String(text ?? '').replace(/\r?\n/g, ' ⏎ ');
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

/** A time as people read it in a list: 2026-10-27 14:03:11 (UTC). */
export const stamp = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) : '—');

/** When "since" means: an ISO time, or a number of minutes ago ("90", "90m"), "2h", "3d"; else 0. */
export function sinceOf(value, now = Date.now()) {
  if (value == null || value === '') return 0;
  const m = /^\s*(\d+(?:\.\d+)?)\s*([mhd]?)\s*$/i.exec(String(value));
  if (m) return now - Number(m[1]) * { '': 60_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2].toLowerCase()];
  const t = Date.parse(String(value));
  return Number.isFinite(t) ? t : 0;
}
