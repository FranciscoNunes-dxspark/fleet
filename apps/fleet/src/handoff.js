// Hand-offs, pure. An app inside the host that copies a line for a sibling (the kit's family.js
// copiedNote) also tells the host, { handoff, line }: the host switches to that sibling, starting it
// if need be, and types the line into its prompt once it reads keys. A line for one of several apps
// (a log line Sonar, Hail or Bosun could take) goes to the first of them that's running, else stays
// on the clipboard only.
import { IDS } from './spaces.js';

/** The space a hand-off goes to: { to, line } or { to: null, why }. `running(id)` says whether one runs; `ids` are the spaces. */
export function routeHandoff(message, { from, running = () => false, ids = IDS } = {}) {
  const line = typeof message?.line === 'string' ? message.line : '';
  const apps = [].concat(message?.handoff ?? []).map((a) => String(a).toLowerCase()).filter((a) => ids.includes(a) && a !== from);
  if (!line.trim()) return { to: null, why: 'nothing to hand over' };
  if (!apps.length) return { to: null, why: 'no app of the host takes it' };
  if (apps.length === 1) return { to: apps[0], line };
  const to = apps.find(running);
  return to ? { to, line } : { to: null, why: 'none of them is running' };
}

/**
 * What to type into the app for `line`: the line as one write, which the apps take as a paste (the
 * prompt opens with it, and ↵ runs it). Line breaks would run it, or part of it, so they go.
 */
export const pasteFor = (line) => String(line).replace(/[\r\n]+/g, ' ').trim();
