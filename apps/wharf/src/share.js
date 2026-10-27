// What Wharf hands its siblings and takes from them (family.js): a log line as a `logline` context,
// and finding one in a container's or pod's log. Pure.
import { redactSecrets, requestIdIn } from '@fleet/kit/family.js';
import { isTrouble, logLine } from './rows.js';

const STAMP = /^(\d{4}-\d\d-\d\dT[\d:.]+Z?) /;

/** The newest line of `text` that reads as trouble (Docker's timestamp and all), or null. */
export function latestTrouble(text) {
  const lines = String(text ?? '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i] && isTrouble(lines[i])) return lines[i];
  return null;
}

/**
 * A log line as a `logline` context's data: { process, text, time?, requestId?, project? }, the timestamp moved
 * out of the text and anything that looks like a secret blanked. The request is looked for in the line, then
 * the five before it in `log`, as Bosun does, so Sonar and Hail can find what the request did.
 */
export function loglineData({ process, line, project, log = '' }) {
  const time = STAMP.exec(line)?.[1];
  const lines = String(log).split('\n');
  const at = lines.lastIndexOf(line);
  let requestId = null;
  for (let i = at < 0 ? -1 : at; i >= Math.max(0, at - 5) && !requestId; i--) requestId = requestIdIn(lines[i]);
  if (!requestId) requestId = requestIdIn(line);
  const text = redactSecrets(logLine(line).replace(/^\d\d:\d\d:\d\d /, '').slice(0, 500));
  return { process, text, ...(time ? { time } : {}), ...(requestId ? { requestId } : {}), ...(project ? { project } : {}) };
}

const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * The text of a `logline` context to look for in logs: the line without its level's noise, short enough
 * that a log that cut or reformatted the line still matches.
 */
export const needleOf = (data) => squash(data.text).slice(0, 120);

/** Whether `log` holds a line containing `needle` (as needleOf makes it). */
export function hasLine(log, needle) {
  if (!needle) return false;
  return String(log ?? '')
    .split('\n')
    .some((l) => squash(logLine(l)).includes(needle));
}

/**
 * What to search a log for to show a `logline` context's line: its text if the log has it, else the
 * request it names (any line of the log that carries it), else null.
 */
export function matchIn(log, data) {
  const needle = needleOf(data);
  if (hasLine(log, needle)) return needle;
  if (data.requestId && String(log ?? '').toLowerCase().includes(String(data.requestId).toLowerCase())) return String(data.requestId);
  return null;
}
