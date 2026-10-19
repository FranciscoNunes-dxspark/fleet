// Things done at a set time, shared by everyone using this Keel server, as the
// person who scheduled them:
// - complete a pull request ("Complete at 18:00"), with the merge options they
//   chose, and only if it's still ready: active, not a draft, no conflicts,
//   approved and with its required checks passed. Otherwise it says why it
//   didn't. Policies are never overridden.
// - run a pipeline on a branch, once ("Run at 02:00"). Recurring runs belong
//   in the pipeline's own schedule (cron in its YAML).
// Schedules live in the data folder (schedules.json); one server process does
// them. Outcomes reach the person who scheduled them through their live updates
// and push notifications (domain/changes.js).
import crypto from 'node:crypto';
import path from 'node:path';
import { config } from './config.js';
import { runnerLock, sharedJson } from './jsonfile.js';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const MAX_AHEAD = 30 * DAY;
// Later than this (the server was down at the time), it's not done: merging hours late may be the wrong time.
const LATE = 60 * MIN;
const KEEP = 7 * DAY; // outcomes are kept this long
const STRATEGIES = ['squash', 'noFastForward', 'rebase', 'rebaseMerge'];
// Entries from before pipeline runs could be scheduled are completions.
const kindOf = (s) => s.kind || 'complete';
const isCompletion = (s) => kindOf(s) === 'complete';
const bad = (message, status = 400) => Object.assign(new Error(message), { status });

export const prKey = (projectId, repoId, prId) => `${projectId}/${repoId}/${prId}`;

/**
 * Why a pull request can't be completed now, or null when it can: the same
 * conditions Keel checks before a scheduled completion.
 */
export function notReady(pr) {
  if (pr.status === 'completed') return 'It was already completed';
  if (pr.status === 'abandoned') return 'It was abandoned';
  if (pr.status !== 'active') return `It is ${pr.status}`;
  if (pr.isDraft) return 'It is still a draft';
  if (pr.mergeStatus === 'conflicts') return 'It has merge conflicts';
  if (pr.reviewState !== 'approved') {
    return {
      rejected: 'A reviewer rejected it',
      'waiting-author': 'A reviewer is waiting for the author',
      'no-reviewers': 'It has no reviewers',
    }[pr.reviewState] || "It isn't approved yet";
  }
  const pending = (pr.policies || []).filter((p) => p.isBlocking && !['approved', 'notApplicable'].includes(p.status));
  if (pending.length) return `Required checks haven't passed: ${pending.map((p) => p.name).join(', ')}`;
  return null;
}

export function createSchedules({
  dataDir = config.dataDir,
  mock = config.mock,
  // (ownerId) -> the service that acts for the person who scheduled it, or null.
  resolveService,
  every = 30_000,
} = {}) {
  const suffix = mock ? '.mock' : '';
  const store = sharedJson(path.join(dataDir, `schedules${suffix}.json`), () => ({ schedules: [] }));
  const runner = runnerLock(path.join(dataDir, `schedule-runner${suffix}.json`), 3 * MIN);
  const all = () => store.get().schedules || [];
  const update = (id, patch) => store.update((s) => {
    s.schedules = (s.schedules || []).map((x) => (x.id === id ? { ...x, ...patch } : x));
  });
  const view = (s) => ({
    id: s.id, kind: kindOf(s), projectId: s.projectId, at: s.at, ownerId: s.ownerId, ownerName: s.ownerName,
    status: s.status, reason: s.reason || null, finishedAt: s.finishedAt || null, createdAt: s.createdAt,
    ...(isCompletion(s)
      ? { repoId: s.repoId, prId: s.prId, title: s.title, mergeStrategy: s.options.mergeStrategy }
      : { definitionId: s.definitionId, pipelineName: s.pipelineName, branch: s.branch, run: s.run || null }),
  });
  const ownerOf = (owner) => ({ ownerId: owner?.id ?? null, ownerName: owner?.name ?? null });
  const checkTime = (at, ms) => {
    const when = Date.parse(at);
    if (!Number.isFinite(when)) throw bad('Pick a date and time');
    if (when < ms + MIN) throw bad('Pick a time at least a minute from now');
    if (when > ms + MAX_AHEAD) throw bad('Pick a time within the next 30 days');
    return new Date(when).toISOString();
  };

  async function complete(s, ms) {
    const done = (status, reason = null, extra = {}) => update(s.id, { status, reason, finishedAt: new Date(ms).toISOString(), ...extra });
    if (ms - Date.parse(s.at) > LATE) return done('skipped', "Keel wasn't running at the time");
    let service;
    try {
      service = await resolveService(s.ownerId || null);
    } catch {
      service = null;
    }
    if (!service) return done('failed', 'The person who scheduled it has no working Azure DevOps token in Keel');
    if (!isCompletion(s)) {
      try {
        const run = await service.queueBuild(s.projectId, s.definitionId, s.branch);
        return done('done', null, { run: { id: run?.id ?? null, webUrl: run?.webUrl || null } });
      } catch (err) {
        return done('failed', err.message);
      }
    }
    try {
      service.invalidate('pr:'); // as it is now, not a minute ago
      const pr = await service.pullRequest(s.projectId, s.repoId, s.prId);
      const why = notReady(pr);
      if (why) return done('skipped', why);
      await service.prAction(s.projectId, s.repoId, s.prId, { type: 'complete', ...s.options });
      service.invalidate('prs:');
      return done('done');
    } catch (err) {
      return done('failed', err.message);
    }
  }

  let busy = false;
  /** One look: complete what's due, and forget outcomes older than a week. */
  async function tick(ms = Date.now()) {
    if (busy || !runner.isRunner()) return;
    busy = true;
    try {
      store.update((s) => {
        s.schedules = (s.schedules || []).filter((x) => x.status === 'scheduled' || ms - Date.parse(x.finishedAt || x.at) < KEEP);
      });
      // One at a time: two PRs into the same branch shouldn't race, nor runs queue all at once.
      for (const s of all().filter((x) => x.status === 'scheduled' && Date.parse(x.at) <= ms)) await complete(s, ms);
    } finally {
      busy = false;
    }
  }

  const timer = setInterval(() => tick().catch((err) => console.warn(`[schedules] ${err.message}`)), every);
  timer.unref?.();

  return {
    /**
     * Schedule a PR's completion at `at`, replacing any earlier schedule for it.
     * `pr` is the pull request as its panel shows it (to check it can be completed at all).
     */
    add({ pr, at, options = {}, owner = null }, ms = Date.now()) {
      const when = Date.parse(checkTime(at, ms));
      if (pr.status !== 'active') throw bad('Only an active pull request can be completed');
      if (pr.isDraft) throw bad('Publish the draft first');
      const s = {
        id: crypto.randomUUID(),
        projectId: pr.projectId,
        repoId: pr.repoId,
        prId: pr.id,
        title: String(pr.title || '').slice(0, 300),
        at: new Date(when).toISOString(),
        options: {
          mergeStrategy: STRATEGIES.includes(options.mergeStrategy) ? options.mergeStrategy : 'noFastForward',
          deleteSourceBranch: !!options.deleteSourceBranch,
          transitionWorkItems: !!options.transitionWorkItems,
          ...(options.mergeCommitMessage ? { mergeCommitMessage: String(options.mergeCommitMessage).slice(0, 4000) } : {}),
        },
        ...ownerOf(owner),
        status: 'scheduled',
        createdAt: new Date(ms).toISOString(),
      };
      const key = prKey(s.projectId, s.repoId, s.prId);
      store.update((st) => {
        st.schedules = [...(st.schedules || []).filter((x) => !(isCompletion(x) && x.status === 'scheduled' && prKey(x.projectId, x.repoId, x.prId) === key)), s];
      });
      return view(s);
    },

    /** Run a pipeline on a branch once, at `at`. `pipeline`: { projectId, definition: { id, name } }. */
    addRun({ pipeline, branch, at, owner = null }, ms = Date.now()) {
      const when = checkTime(at, ms);
      const b = String(branch || '').trim().replace(/^refs\/heads\//, '');
      if (!b) throw bad('Pick a branch');
      if (b.length > 250 || /[\s~^:?*[\\]|\.\.|@\{|^\/|\/$/.test(b)) throw bad(`"${b}" isn't a valid branch name`);
      const s = {
        id: crypto.randomUUID(),
        kind: 'run',
        projectId: pipeline.projectId,
        definitionId: Number(pipeline.definition.id),
        pipelineName: String(pipeline.definition.name || '').slice(0, 200),
        branch: b,
        at: when,
        ...ownerOf(owner),
        status: 'scheduled',
        createdAt: new Date(ms).toISOString(),
      };
      store.update((st) => {
        st.schedules = [...(st.schedules || []), s];
      });
      return view(s);
    },

    /** A pipeline's scheduled runs, soonest first, and its runs' outcomes from the last day. */
    forPipeline(projectId, definitionId, ms = Date.now()) {
      return all()
        .filter((x) => kindOf(x) === 'run' && x.projectId === projectId && x.definitionId === Number(definitionId)
          && (x.status === 'scheduled' || ms - Date.parse(x.finishedAt || x.at) < DAY))
        .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
        .map(view);
    },

    /** Pipeline key ("projectId:definitionId") -> its scheduled runs, soonest first. */
    upcomingRuns() {
      const out = new Map();
      for (const x of all().filter((s) => kindOf(s) === 'run' && s.status === 'scheduled').sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
        const key = `${x.projectId}:${x.definitionId}`;
        out.set(key, [...(out.get(key) || []), view(x)]);
      }
      return out;
    },

    /** What a schedule is ('complete' or 'run'), or null if it's gone. */
    kindOf: (id) => {
      const s = all().find((x) => x.id === id);
      return s ? kindOf(s) : null;
    },

    /** Cancel a schedule: the person who scheduled it, or an Admin. */
    cancel(id, { ownerId = null, admin = false } = {}) {
      const s = all().find((x) => x.id === id);
      if (!s) throw bad('That schedule no longer exists', 404);
      if (s.status !== 'scheduled') throw bad('It already ran', 409);
      if (!admin && (s.ownerId ?? null) !== (ownerId ?? null)) throw bad('Only the person who scheduled it, or an Admin, can cancel it', 403);
      store.update((st) => {
        st.schedules = (st.schedules || []).filter((x) => x.id !== id);
      });
      return { ok: true };
    },

    /** A PR's scheduled completion, else its latest outcome from the last day. */
    forPr(projectId, repoId, prId, ms = Date.now()) {
      const key = prKey(projectId, repoId, prId);
      const mine = all().filter((x) => isCompletion(x) && prKey(x.projectId, x.repoId, x.prId) === key);
      const s = mine.find((x) => x.status === 'scheduled')
        || mine.filter((x) => ms - Date.parse(x.finishedAt || x.at) < DAY).sort((a, b) => Date.parse(b.finishedAt) - Date.parse(a.finishedAt))[0];
      return s ? view(s) : null;
    },

    /** PR key -> when it's scheduled to complete. */
    upcoming() {
      return new Map(all().filter((x) => isCompletion(x) && x.status === 'scheduled').map((x) => [prKey(x.projectId, x.repoId, x.prId), x.at]));
    },

    /** One person's schedules and outcomes (for their live updates and notifications). */
    forOwner(ownerId) {
      return all().filter((x) => (x.ownerId ?? null) === (ownerId ?? null)).map(view);
    },

    tick,
    close: () => clearInterval(timer),
  };
}
