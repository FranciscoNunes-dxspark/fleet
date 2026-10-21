import { Readable } from 'node:stream';
import express from 'express';
import { PERMISSIONS, can } from './accounts.js';
import { createOrgStore } from './orgs.js';
import { createTypeColorStore } from './typecolors.js';

const INLINE_IMAGES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };

/**
 * API routes; `req.ctx` is the signed-in user's { service, watcher } (see index.js).
 * `channels` posts to Teams and Slack (channels.js), shared by the server;
 * `push` sends notifications to people's devices (push.js).
 */
export function apiRouter({ channels = null, push = null, schedules = null } = {}) {
  const orgs = createOrgStore(); // reads data/orgs.json, shared with sign-in and other processes
  const typeColors = createTypeColorStore(); // data/type-colors.json, the same for everyone
  const r = express.Router();
  r.use(express.json({ limit: '256kb' }));

  // Writes require a custom header. Browsers can't send it cross-origin without
  // a CORS preflight (which we never approve), so other sites can't drive this
  // API with your PAT behind it.
  r.use((req, res, next) => {
    if (req.method !== 'GET' && req.get('x-keel') !== '1') {
      return res.status(403).json({ error: 'Missing x-keel header' });
    }
    next();
  });

  /** Role check: refuses the request unless the signed-in role has `perm`. */
  const need = (perm) => (req, res, next) => (can(req.ctx.role || 'admin', perm)
    ? next()
    : res.status(403).json({ error: 'Your role in Keel does not allow this.', code: 'forbidden' }));

  const num = (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw Object.assign(new Error('Invalid id'), { status: 400 });
    return n;
  };

  r.get('/meta', async (req, res) => {
    const role = req.ctx.role || 'admin';
    res.json({ ...(await req.ctx.service.meta()), typeColors: typeColors.get(), account: req.ctx.user || null, role, permissions: PERMISSIONS[role] || [] });
  });
  // Preferences that follow you across devices (theme, notifications, dashboard layout).
  r.put('/prefs', async (req, res) => res.json(await req.ctx.service.savePrefs(req.body || {})));
  // Live updates (Server-Sent Events): 'changed', 'notify' and 'status' events.
  r.get('/events', (req, res) => req.ctx.watcher.attach(req, res));
  r.post('/refresh', (req, res) => {
    req.ctx.service.invalidate('');
    req.ctx.watcher.pollNow();
    res.json({ ok: true });
  });

  r.get('/attention', async (req, res) => res.json(await req.ctx.service.attention()));
  r.post('/attention/snooze', async (req, res) => {
    const { key, days } = req.body || {};
    if (typeof key !== 'string' || !key) return res.status(400).json({ error: 'key required' });
    await req.ctx.service.snooze(key, Number(days) || 0);
    res.json({ ok: true });
  });
  r.post('/attention/clear-snoozes', async (req, res) => {
    await req.ctx.service.clearSnoozes();
    res.json({ ok: true });
  });

  r.get('/image', async (req, res) => {
    const { type, body } = await req.ctx.service.provider.fetchOrgImage(String(req.query.url || ''));
    res.set({ 'Content-Type': type, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'" });
    res.send(body);
  });

  r.get('/people',async (req, res) => res.json(await req.ctx.service.people()));
  r.get('/prs', async (req, res) => res.json(await req.ctx.service.pullRequests()));
  r.get('/prs/closed', async (req, res) => res.json(await req.ctx.service.closedPullRequests(Number(req.query.days) || 30)));
  r.post('/prs', need('prs.write'), async (req, res) => res.status(201).json(await req.ctx.service.createPullRequest(req.body || {})));
  r.get('/repos', async (req, res) => res.json(await req.ctx.service.repos()));
  r.get('/repos/:projectId/:repoId/branches', async (req, res) => res.json(await req.ctx.service.branches(req.params.projectId, req.params.repoId)));
  r.get('/repos/:projectId/:repoId/compare', async (req, res) => res.json(await req.ctx.service.compare(
    req.params.projectId, req.params.repoId, String(req.query.source || ''), String(req.query.target || ''),
  )));
  // Reviewers to suggest for a change: { paths, target, exclude, author } (POST: the file list can be long).
  r.post('/repos/:projectId/:repoId/reviewers', async (req, res) => res.json(await req.ctx.service.suggestReviewers(req.params.projectId, req.params.repoId, {
    paths: Array.isArray(req.body?.paths) ? req.body.paths : [],
    target: req.body?.target ? String(req.body.target) : undefined,
    exclude: Array.isArray(req.body?.exclude) ? req.body.exclude.map(String) : [],
    author: req.body?.author ? String(req.body.author) : undefined,
  })));
  // Commit history: all tracked repos (default branches), or ?project=&repo=&branch= for one.
  r.get('/commits', async (req, res) => res.json(await req.ctx.service.commits({
    projectId: req.query.project ? String(req.query.project) : undefined,
    repoId: req.query.repo ? String(req.query.repo) : undefined,
    branch: req.query.branch ? String(req.query.branch) : undefined,
    days: Math.min(90, Math.max(1, Number(req.query.days) || 14)),
  })));
  r.get('/commits/:projectId/:repoId/:commitId', async (req, res) => {
    const { projectId, repoId, commitId } = req.params;
    if (!/^[0-9a-f]{7,40}$/i.test(commitId)) return res.status(400).json({ error: 'Invalid commit id' });
    return res.json(await req.ctx.service.commit(projectId, repoId, commitId.toLowerCase()));
  });
  r.get('/prs/:projectId/:repoId/:id', async (req, res) => {
    const { projectId, repoId, id } = req.params;
    res.json(await req.ctx.service.pullRequest(projectId, repoId, num(id)));
  });
  r.get('/prs/:projectId/:repoId/:id/conflicts', async (req, res) => {
    const { projectId, repoId, id } = req.params;
    res.json(await req.ctx.service.pullRequestConflicts(projectId, repoId, num(id)));
  });
  // Complete a pull request at a set time (schedules.js), as the person scheduling it.
  r.post('/prs/:projectId/:repoId/:id/schedule', need('prs.write'), async (req, res) => {
    if (!schedules) throw Object.assign(new Error('Scheduling is not available on this server'), { status: 404 });
    const { projectId, repoId, id } = req.params;
    const { at, ...options } = req.body || {};
    const pr = await req.ctx.service.pullRequest(projectId, repoId, num(id));
    schedules.add({ pr, at, options, owner: req.ctx.user ? { id: req.ctx.user.id, name: req.ctx.user.name } : null });
    res.json(await req.ctx.service.pullRequest(projectId, repoId, num(id)));
  });
  // Run a pipeline on a branch once, at a set time, as the person scheduling it.
  r.post('/pipelines/schedule', need('pipelines.run'), async (req, res) => {
    if (!schedules) throw Object.assign(new Error('Scheduling is not available on this server'), { status: 404 });
    const { projectId, definitionId, branch, at } = req.body || {};
    const { pipeline } = await req.ctx.service.pipelineRuns(projectId, num(definitionId));
    if (!pipeline) throw Object.assign(new Error('That pipeline isn\'t one of your tracked pipelines'), { status: 400 });
    schedules.addRun({ pipeline, branch, at, owner: req.ctx.user ? { id: req.ctx.user.id, name: req.ctx.user.name } : null });
    res.json(await req.ctx.service.pipelineRuns(projectId, num(definitionId)));
  });
  // Cancel a schedule: what it does decides the permission (completing PRs, or running pipelines).
  r.delete('/schedules/:id', (req, res) => {
    if (!schedules) throw Object.assign(new Error('Scheduling is not available on this server'), { status: 404 });
    const role = req.ctx.role || 'admin';
    if (!can(role, schedules.kindOf(req.params.id) === 'run' ? 'pipelines.run' : 'prs.write')) {
      return res.status(403).json({ error: 'Your role in Keel does not allow this.', code: 'forbidden' });
    }
    res.json(schedules.cancel(req.params.id, { ownerId: req.ctx.user?.id ?? null, admin: role === 'admin' }));
  });
  r.post('/prs/:projectId/:repoId/:id/actions', need('prs.write'), async (req, res) => {
    const { projectId, repoId, id } = req.params;
    await req.ctx.service.prAction(projectId, repoId, num(id), req.body || {});
    res.json(await req.ctx.service.pullRequest(projectId, repoId, num(id)));
  });

  r.get('/workitems', async (req, res) => res.json(await req.ctx.service.workItems()));
  r.get('/workitems/new/options', async (req, res) => res.json(await req.ctx.service.newWorkItemOptions()));
  r.post('/workitems', need('workitems.write'), async (req, res) => res.status(201).json(await req.ctx.service.createWorkItem(req.body || {})));
  // Work item numbers are per organization: ?org= picks one (the primary when absent).
  const orgOf = (req) => (req.query.org ? String(req.query.org) : undefined);
  r.get('/workitems/:id', async (req, res) => res.json(await req.ctx.service.workItem(num(req.params.id), orgOf(req))));
  // Attachments are other people's files: only plain images open in the browser,
  // everything else downloads, and nothing served here can run scripts.
  r.get('/workitems/:id/attachments/:attachmentId', async (req, res) => {
    const { name, length, stream } = await req.ctx.service.workItemAttachment(num(req.params.id), String(req.params.attachmentId), orgOf(req));
    const image = INLINE_IMAGES[String(name).split('.').pop().toLowerCase()];
    const inline = req.query.inline === '1' && image;
    const ascii = String(name).replace(/[^\x20-\x7e]|["\\]/g, '_');
    res.set({
      'Content-Type': inline ? image : 'application/octet-stream',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    });
    if (length) res.set('Content-Length', String(length));
    const body = Readable.fromWeb(stream);
    body.on('error', () => res.destroy());
    body.pipe(res);
  });
  // The file is the raw request body and its name is in ?name=, so no multipart parsing.
  // 60 MB is the most Azure DevOps takes in one upload.
  const fileBody = express.raw({ type: () => true, limit: '60mb' });
  const readFile = (req, res, next) => fileBody(req, res, (err) => next(err?.type === 'entity.too.large'
    ? Object.assign(new Error("Files over 60 MB can't be attached"), { status: 413 })
    : err));
  r.post('/workitems/:id/attachments', need('workitems.write'), readFile, async (req, res) => {
    const id = num(req.params.id);
    await req.ctx.service.addWorkItemAttachment(id, { name: req.query.name, content: Buffer.isBuffer(req.body) ? req.body : null }, orgOf(req));
    res.status(201).json(await req.ctx.service.workItem(id, orgOf(req)));
  });
  r.post('/workitems/:id/actions', need('workitems.write'), async (req, res) => {
    const id = num(req.params.id);
    await req.ctx.service.workItemAction(id, req.body || {}, orgOf(req));
    res.json(await req.ctx.service.workItem(id, orgOf(req)));
  });

  r.post('/board/reorder', need('workitems.write'), async (req, res) => {
    const { projectId, teamId, id, previousId, nextId } = req.body || {};
    res.json(await req.ctx.service.reorderBoard(String(projectId || ''), { teamId: String(teamId || ''), id, previousId, nextId }));
  });
  r.get('/board', async (req, res) => res.json(await req.ctx.service.board({
    projectId: req.query.project,
    teamId: req.query.team,
    boardId: req.query.board,
    mode: req.query.mode,
    doneDays: Math.min(90, Math.max(1, Number(req.query.doneDays) || 14)),
  })));
  r.get('/epics', async (req, res) => res.json(await req.ctx.service.epics({ includeClosed: req.query.closed === '1' })));
  r.get('/pipelines', async (req, res) => res.json(await req.ctx.service.pipelines()));
  r.get('/pipelines/:projectId/:definitionId/runs', async (req, res) => res.json(await req.ctx.service.pipelineRuns(req.params.projectId, req.params.definitionId)));
  r.get('/builds/:projectId/:buildId', async (req, res) => res.json(await req.ctx.service.runDetails(req.params.projectId, req.params.buildId)));
  r.get('/tests/flaky', async (req, res) => res.json(await req.ctx.service.flakyTests()));
  r.post('/pipelines/cancel', need('pipelines.run'), async (req, res) => {
    const { projectId, buildId } = req.body || {};
    res.json(await req.ctx.service.cancelBuild(String(projectId || ''), num(buildId)));
  });
  r.post('/pipelines/queue', need('pipelines.run'), async (req, res) => {
    const { projectId, definitionId, branch } = req.body || {};
    res.json(await req.ctx.service.queueBuild(projectId, num(definitionId), branch));
  });

  r.get('/production', async (req, res) => res.json(await req.ctx.service.production()));
  r.get('/production/monitors', (req, res) => res.json(req.ctx.service.monitors().list()));
  r.put('/production/monitors', need('monitors.manage'), async (req, res) => {
    const saved = await req.ctx.service.monitors().save(req.body?.monitors);
    req.ctx.service.invalidate('builds');
    res.json(saved);
  });
  r.post('/production/test', need('monitors.manage'), async (req, res) => res.json(await req.ctx.service.monitors().test(req.body || {})));
  // Platform totals (platform/v1 /totals): everyone reads the sites they see, admins fetch on demand.
  r.get('/production/totals', async (req, res) => res.json(await req.ctx.service.platformTotals()));
  r.get('/production/totals/:id', async (req, res) => res.json(await req.ctx.service.platformTotalsFor(req.params.id)));
  r.post('/production/totals/fetch', need('monitors.manage'), async (req, res) => res.status(202).json(await req.ctx.service.fetchAllTotals()));
  r.post('/production/totals/:id/fetch', need('monitors.manage'), (req, res) => res.status(202).json(req.ctx.service.monitors().fetchTotalsNow(req.params.id)));
  // Push notifications on your own devices: anyone can turn them on for themselves.
  const pushOrFail = () => {
    if (!push) throw Object.assign(new Error('Push notifications are not available on this server'), { status: 404 });
    return push;
  };
  const userId = (req) => req.ctx.user?.id || null;
  r.get('/push', (req, res) => res.json(pushOrFail().info(userId(req))));
  r.post('/push/subscribe', (req, res) => res.json(pushOrFail().subscribe(userId(req), req.body || {})));
  r.post('/push/unsubscribe', (req, res) => res.json(pushOrFail().unsubscribe(userId(req), req.body || {})));
  r.post('/push/test', async (req, res) => res.json(await pushOrFail().test(userId(req), req.body || {})));

  // Teams and Slack channels: Admins set them up; posts run on the server whether or not anyone is looking.
  const channelsOrFail = () => {
    if (!channels) throw Object.assign(new Error('Posting to channels is not available on this server'), { status: 404 });
    return channels;
  };
  r.get('/channels', need('channels.manage'), (req, res) => res.json(channelsOrFail().list()));
  r.put('/channels', need('channels.manage'), async (req, res) => res.json(await channelsOrFail().save(req.body?.channels, req.ctx.user ? { id: req.ctx.user.id, name: req.ctx.user.name } : null)));
  r.post('/channels/test', need('channels.manage'), async (req, res) => res.json(await channelsOrFail().test(req.body || {})));
  r.post('/channels/:id/weekly', need('channels.manage'), async (req, res) => res.json(await channelsOrFail().sendWeekly(req.params.id, req.ctx.service)));
  // Team page: hide someone from your own view, or take them out of a team in Azure DevOps.
  r.post('/team/hidden', async (req, res) => res.json(await req.ctx.service.setHidden(req.body?.person, !!req.body?.hidden)));
  r.post('/team/remove', need('team.manage'), async (req, res) => {
    const { projectId, teamId, memberId } = req.body || {};
    res.json(await req.ctx.service.removeTeamMember(String(projectId || ''), String(teamId || ''), String(memberId || '')));
  });
  r.get('/releases', async (req, res) => res.json(await req.ctx.service.releases()));
  r.post('/releases/create', need('releases.run'), async (req, res) => {
    const { projectId, definitionId, description } = req.body || {};
    res.json(await req.ctx.service.createRelease(projectId, num(definitionId), description));
  });
  r.post('/releases/deploy', need('releases.run'), async (req, res) => {
    const { projectId, releaseId, environmentId, comment } = req.body || {};
    await req.ctx.service.deployReleaseStage(projectId, num(releaseId), num(environmentId), comment);
    res.json({ ok: true });
  });
  r.post('/approvals/:kind/:id', need('approvals.decide'), async (req, res) => {
    if (!['release', 'yaml'].includes(req.params.kind)) return res.status(400).json({ error: 'Unknown approval kind' });
    await req.ctx.service.decideApproval(req.params.kind, req.params.id, req.body || {}, req.query.org ? String(req.query.org) : undefined);
    res.json({ ok: true });
  });

  // Production deploys: what one shipped, and delivery metrics (DORA) over a period.
  r.get('/deploys/:projectId/changes', async (req, res) => res.json(await req.ctx.service.deployChanges(
    req.params.projectId, String(req.query.target || ''), String(req.query.id || ''),
  )));
  // What's merged but not deployed yet, per production environment.
  r.get('/deploys/pending', async (req, res) => res.json(await req.ctx.service.undeployed()));
  r.get('/delivery', async (req, res) => res.json(await req.ctx.service.delivery(Math.min(90, Math.max(7, Number(req.query.days) || 30)))));
  // One week's summary for everyone: ?week=YYYY-MM-DD (any day of the week; this week when absent).
  r.get('/summary', async (req, res) => res.json(await req.ctx.service.summary(req.query.week ? String(req.query.week) : undefined)));

  r.get('/team', async (req, res) => res.json(await req.ctx.service.team()));
  r.get('/insights', async (req, res) => {
    const days = Math.min(180, Math.max(7, Number(req.query.days) || 30));
    res.json(await req.ctx.service.insights(days));
  });
  // Work item flow: cycle time, throughput and aging work in progress; and each team's sprint scope.
  r.get('/flow', async (req, res) => res.json(await req.ctx.service.flow(Math.min(180, Math.max(7, Number(req.query.days) || 30)), String(req.query.type || '') || null)));
  r.get('/sprints', async (req, res) => res.json(await req.ctx.service.sprints()));
  r.post('/changelog', async (req, res) => res.json(await req.ctx.service.changelog(req.body || {})));

  // Organizations: everyone sees the list; Admins add, rename and remove them.
  r.get('/orgs', (req, res) => res.json(orgs.all()));
  r.post('/orgs', need('users.manage'), (req, res) => res.status(201).json(orgs.add(req.body || {})));
  r.patch('/orgs/:key', need('users.manage'), (req, res) => {
    orgs.rename(req.params.key, req.body?.name);
    res.json(orgs.get(req.params.key));
  });
  r.delete('/orgs/:key', need('users.manage'), (req, res) => {
    orgs.remove(req.params.key);
    res.json({ ok: true });
  });

  r.get('/workitem-types', async (req, res) => res.json({ types: await req.ctx.service.workItemTypes(), colors: typeColors.get() }));
  r.put('/workitem-types/colors', need('typecolors.manage'), (req, res) => res.json({ colors: typeColors.set(req.body?.colors) }));

  r.get('/settings', async (req, res) => res.json(await req.ctx.service.settingsView()));
  r.get('/settings/projects/:projectId', async (req, res) => res.json(await req.ctx.service.projectOptions(req.params.projectId)));
  r.put('/settings', async (req, res) => {
    const saved = await req.ctx.service.saveSettings(req.body || {});
    req.ctx.watcher.reschedule();
    res.json(saved);
  });

  r.use((req, res) => res.status(404).json({ error: `No API route ${req.method} ${req.path}` }));
  // eslint-disable-next-line no-unused-vars
  r.use((err, req, res, next) => {
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    if (status >= 500) console.error('[api]', err);
    // Azure DevOps rejected the signed-in user's token: end their session so they're asked to sign in again.
    if (err.code === 'token-rejected') req.onTokenRejected?.();
    res.status(status).json({ error: err.message || 'Unexpected error', ...(err.code ? { code: err.code } : {}) });
  });
  return r;
}
