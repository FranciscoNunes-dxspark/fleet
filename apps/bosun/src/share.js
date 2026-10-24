// What Bosun hands its siblings about a process's log: the latest line that read as trouble, with the
// request it was about when the line (or one just before it) names one, as a `logline` context for
// Sonar or Hail to find that request. Pure.
import { isTrouble } from './crew.js';

// The ways logs name a request, in the order they're tried.
const REQUEST_IDS = [
  /x-request-id["']?\s*[:=]\s*["']?([\w.:-]{6,})/i,
  /\brequest[_-]?id["']?\s*[:=]\s*["']?([\w.:-]{6,})/i,
  /\btraceparent["']?\s*[:=]?\s*["']?[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}\b/i,
  /\b00-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}\b/i,
  /\boperation_?Id["']?\s*[:=]\s*["']?([\w.:-]{6,})/i,
];

/** The request a log line names (x-request-id, requestId, request_id, traceparent's trace id, operation_Id), or null. */
export function requestIdIn(text) {
  for (const re of REQUEST_IDS) {
    const m = re.exec(String(text ?? ''));
    if (m) return m[1].replace(/[.:]+$/, '');
  }
  return null;
}

/** The index of the newest line of `lines` ({ text }) that reads as trouble (Bosun's own ── lines aren't), or -1. */
export function latestTrouble(lines) {
  for (let i = lines.length - 1; i >= 0; i--) if (!lines[i].text.startsWith('── ') && isTrouble(lines[i].text)) return i;
  return -1;
}

// What looks like a secret in a line: a password, token or key's value, a bearer token, a URL's password.
const SECRETS = [
  [/\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)(["']?\s*[:=]\s*["']?)[^\s"',;&)\]}]+/gi, '$1$2***'],
  [/\b(Bearer|Basic)\s+[\w.~+/-]+=*/g, '$1 ***'],
  [/(\/\/[^/\s:@]+:)[^@\s/]+@/g, '$1***@'],
];

/** `text` with anything that looks like a secret blanked, so a shared line never carries one. */
export const redact = (text) => SECRETS.reduce((s, [re, to]) => s.replace(re, to), String(text ?? ''));

/**
 * The `logline` context for a process's latest trouble: { project, process, text, time, requestId? },
 * or null when its log has none. The request is looked for in the line, then the five before it.
 */
export function troubleContext(project, p) {
  const at = latestTrouble(p.lines);
  if (at < 0) return null;
  const line = p.lines[at];
  let requestId = null;
  for (let i = at; i >= Math.max(0, at - 5) && !requestId; i--) requestId = requestIdIn(p.lines[i].text);
  return { project, process: p.name, text: redact(line.text.trim()), time: new Date(line.at).toISOString(), ...(requestId ? { requestId } : {}) };
}
