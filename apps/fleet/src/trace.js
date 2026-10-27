// Following one request across the apps. Fleet asks each running app that takes log lines (family.js
// TAKEN_BY.logline) to look for the request, with the /take line of a `logline` context that carries
// its id, as Bosun's t copies one; and reads what it can without them: the family's activity log, and
// Bosun's recorded sessions (~/.bosun/sessions/<project>/<start>.jsonl, BOSUN_HOME moves it), whose
// lines that name the request make a timeline. The folders are injected, so the tests use their own.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { contextIn, readActivity, requestIdIn, takeLine } from '@fleet/kit/family.js';

/** Bosun's folder, as its config.js has it. */
export const bosunHome = (env = process.env) => env.BOSUN_HOME || join(homedir(), '.bosun');

/**
 * The `/take` line that asks an app to find request `id`: a log line whose text is the id, so Bosun and
 * Wharf, which look for the line's text, find it as Sonar and Hail do by `requestId`.
 */
export const traceLine = (id) => takeLine('logline', { process: 'trace', text: String(id), requestId: String(id) });

/**
 * The request a hand-off line is about, or null: a context's requestId or operationId (a log line,
 * an exception), else one named in its text, else one in the line itself.
 */
export function requestIdOfLine(line) {
  const c = contextIn(line);
  if (c) {
    const id = c.data.requestId ?? c.data.operationId ?? requestIdIn(c.data.text ?? c.data.message ?? '');
    return id ? String(id) : null;
  }
  return requestIdIn(line);
}

const mentions = (text, id) => String(text ?? '').toLowerCase().includes(id.toLowerCase());

/**
 * What Fleet can find of request `id` by itself: [{ at, app, source, text }], oldest first, at most
 * `limit` (the newest): activity log entries that mention it (from `familyDir`) and lines of Bosun's
 * sessions under `bosun` (its home) that did, from sessions written to since `since`.
 */
export function traceTimeline(id, { familyDir, bosun, since = 0, limit = 300 } = {}) {
  const needle = String(id ?? '').trim();
  if (!needle) return [];
  const out = [];
  for (const e of readActivity({ dir: familyDir, since, limit: 10_000 })) {
    if (mentions(e.text, needle)) out.push({ at: e.at, app: e.app, source: 'activity', text: String(e.text) });
  }
  if (bosun) {
    const sessions = join(bosun, 'sessions');
    let projects = [];
    try {
      projects = readdirSync(sessions);
    } catch {}
    for (const project of projects) {
      let names = [];
      try {
        names = readdirSync(join(sessions, project)).filter((n) => n.endsWith('.jsonl'));
      } catch {
        continue;
      }
      for (const n of names) {
        const file = join(sessions, project, n);
        let text;
        try {
          if (statSync(file).mtimeMs < since) continue;
          text = readFileSync(file, 'utf8');
        } catch {
          continue;
        }
        // Most lines don't name it: only those that do are parsed.
        if (!mentions(text, needle)) continue;
        let name = null;
        for (const raw of text.split('\n')) {
          const header = raw.startsWith('{"type":"session"');
          if (!header && !mentions(raw, needle)) continue;
          try {
            const e = JSON.parse(raw);
            if (e.type === 'session') name = e.project ?? null;
            else if (e.type === 'line' && Number.isFinite(e.t) && mentions(e.text, needle)) out.push({ at: e.t, app: 'bosun', source: name ? `${name} ${e.p}` : e.p, text: String(e.text) });
          } catch {}
        }
      }
    }
  }
  out.sort((a, b) => a.at - b.at);
  return out.slice(-limit);
}
