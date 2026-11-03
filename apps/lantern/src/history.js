// The last few audits of each page, kept between runs in ~/.lantern/runs.json, so Compare can set
// today's numbers against the last time's. What's kept is what the views show: never a cookie or a
// header's value (the results hold none).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from './config.js';

export const KEEP = 3;
const REQUESTS_KEPT = 300;
const file = () => join(configDir(), 'runs.json');

/** { url: [result, … newest last] }; empty when there's nothing kept (or it can't be read). */
export function loadHistory() {
  try {
    const json = JSON.parse(readFileSync(file(), 'utf8'));
    return json && typeof json === 'object' ? json : {};
  } catch {
    return {};
  }
}

/** `history` with `result` added under its URL, the oldest past KEEP dropped. Pure. */
export function addRun(history, result) {
  const slim = { ...result, requests: result.requests?.slice(0, REQUESTS_KEPT) ?? [] };
  return { ...history, [result.url]: [...(history[result.url] ?? []), slim].slice(-KEEP) };
}

export function saveHistory(history) {
  try {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(`${file()}.tmp`, JSON.stringify(history));
    renameSync(`${file()}.tmp`, file());
  } catch {
    // A read-only home: the history lasts the session.
  }
}
