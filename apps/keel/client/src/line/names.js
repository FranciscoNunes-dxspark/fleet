// The Line's stages as the app shows them: their names, a line on each, and the pages
// folded into each one as its tabs. The rules that place change on the line are in stages.js.
import { t } from '../i18n.js';

/** A stage's name, in the current language. */
export const stageName = (id) => ({
  planned: t('Planned'), building: t('Building'), review: t('In review'),
  merged: t('Merged'), deploying: t('Deploying'), live: t('Live'),
})[id];

/** What a stage holds, in a few words. */
export const stageHint = (id) => ({
  planned: t('Not started yet'), building: t('Being worked on'), review: t('Pull requests open'),
  merged: t('Waiting to ship'), deploying: t('On its way out'), live: t('In production'),
})[id];

/**
 * The pages each stage holds, as its tabs: first the stage's own cards (most stuck first),
 * then the pages that look at that stage in depth. Every one of them lights its station.
 */
export const stagePages = (id) => ({
  planned: [[t('Stuck first'), '/line/planned'], [t('Work items'), '/work'], [t('Epics'), '/epics']],
  building: [[t('Stuck first'), '/line/building'], [t('Board'), '/board']],
  review: [[t('Stuck first'), '/line/review'], [t('Pull requests'), '/prs'], [t('Commits'), '/commits'], [t('Release notes'), '/release-notes']],
  merged: [[t('Stuck first'), '/line/merged'], [t('Waiting to ship'), '/ship']],
  deploying: [[t('Stuck first'), '/line/deploying'], [t('Pipelines'), '/pipelines']],
  live: [[t('Stuck first'), '/line/live'], [t('Monitors'), '/production'], [t('Platform totals'), '/totals']],
})[id] || [];

const PATHS = {
  planned: ['/line/planned', '/work', '/epics'],
  building: ['/line/building', '/board', '/sprint'],
  review: ['/line/review', '/prs', '/commits', '/release-notes'],
  merged: ['/line/merged', '/ship'],
  deploying: ['/line/deploying', '/pipelines'],
  live: ['/line/live', '/production', '/totals'],
};

/** The stage a page belongs to, or null for the pages beside the line (Inbox, Team, Settings…). */
export function stageOfPath(pathname) {
  for (const [id, paths] of Object.entries(PATHS)) {
    if (paths.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return id;
  }
  return null;
}
