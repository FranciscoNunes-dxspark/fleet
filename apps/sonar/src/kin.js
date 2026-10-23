// What Sonar itself does with the family (family.js, shared by all five apps, has the rest): the
// siblings' names and mascots, and the line said when something is copied for one. Pure.
import { contextIn, describeContext } from './family.js';

/** The apps as their names are written. */
export const APP_NAMES = { splice: 'Splice', trawl: 'Trawl', sonar: 'Sonar', bosun: 'Bosun', hail: 'Hail' };

/** The siblings' mascots, as they sign their moods. */
export const PET_NAMES = { splice: 'Twig', trawl: 'Glim', sonar: 'Ping', bosun: 'Squawk', hail: 'Hoot' };

/** The log line for `line` copied for `app`: what to do with it, then the line (or, for a /take, what it holds). */
export function copiedNote(app, line) {
  const name = APP_NAMES[app] ?? app;
  const context = contextIn(line);
  return `Copied for ${name}: paste it into ${name}'s prompt\n${context ? describeContext(context) : line}`;
}
