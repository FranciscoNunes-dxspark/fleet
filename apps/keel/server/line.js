// The Line on the server: built from the same answers the pages get, with each project's
// limits and backlog levels (service.lineSetup), and its daily history kept per person in
// the data folder. The rules are the client's own (client/src/line/stages.js), shared as the
// i18n dictionaries are, so the web app, the terminal app and the alerts agree.
import path from 'node:path';
import { config } from './config.js';
import { sharedJson } from './jsonfile.js';
import { buildLine, trackTones } from '../client/src/line/stages.js';
import { record, redFor, summarize, turnedRed } from './domain/linehistory.js';
import { seedHistory } from './mock/linehistory.js';

/** Every stage of the Line now, for one person's service (one organization or several). */
export async function lineOf(service, now = Date.now()) {
  const [workitems, prs, pending, pipelines, approvals, production, setup] = await Promise.all([
    service.workItems(), service.pullRequests(), service.undeployed(), service.pipelines(),
    service.approvals().catch(() => []), service.production().catch(() => ({ monitors: [] })), service.lineSetup(),
  ]);
  const stages = buildLine({ workitems, prs, pending, pipelines, approvals, production }, now, setup);
  return { stages, tracks: trackTones(stages), limits: setup.limits };
}

let store = null;
const history = () => {
  store ||= sharedJson(path.join(config.dataDir, `line-history${config.mock ? '.mock' : ''}.json`), () => ({}));
  return store;
};

/**
 * Notes today's look at the line for this person (`scope`: their account id, or "local") and
 * returns their history, oldest first, and the stages that have just turned red since the last look.
 */
export function remember(scope, stages, now = Date.now()) {
  const file = history();
  const all = file.get();
  // The demo starts with a month behind it, so its history has something to show.
  const past = all[scope]?.length ? all[scope] : config.mock ? seedHistory(stages, now) : [];
  const before = past.at(-1) || null;
  const entry = summarize(stages, now);
  const entries = record(past, entry);
  file.save({ ...all, [scope]: entries });
  return { entries, red: turnedRed(before, entry) };
}

/** A person's history as the page shows it: each stage's days and how long it has been red. */
export function historyView(entries) {
  const ids = Object.keys(entries.at(-1)?.stages || {});
  return {
    days: entries.map((e) => ({ day: e.day, stages: e.stages })),
    redFor: Object.fromEntries(ids.map((id) => [id, redFor(entries, id)])),
  };
}
