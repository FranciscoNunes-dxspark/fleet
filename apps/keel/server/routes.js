import express from 'express';

/** API routes; `req.ctx` is the signed-in user's { service, watcher } (see index.js). */
export function apiRouter() {
  const r = express.Router();
  r.use(express.json({ limit: '256kb' }));

  // Writes require a custom header. Browsers can't send it cross-origin without
  // a CORS preflight (which we never approve), so other sites can't drive this
  // API with your PAT behind it.
  r.use((req, res, next) => {
    if (req.method !== 'GET' && req.get('x-shipdeck') !== '1') {
      return res.status(403).json({ error: 'Missing x-shipdeck header' });
    }
    next();
  });

  const num = (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw Object.assign(new Error('Invalid id'), { status: 400 });
    return n;
  };

  r.get('/meta', async (req, res) => res.json(await req.ctx.service.meta()));
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
  r.post('/prs', async (req, res) => res.status(201).json(await req.ctx.service.createPullRequest(req.body || {})));
  r.get('/repos', async (req, res) => res.json(await req.ctx.service.repos()));
  r.get('/repos/:projectId/:repoId/branches', async (req, res) => res.json(await req.ctx.service.branches(req.params.projectId, req.params.repoId)));
  r.get('/repos/:projectId/:repoId/compare', async (req, res) => res.json(await req.ctx.service.compare(
    req.params.projectId, req.params.repoId, String(req.query.source || ''), String(req.query.target || ''),
  )));
  r.get('/prs/:projectId/:repoId/:id', async (req, res) => {
    const { projectId, repoId, id } = req.params;
    res.json(await req.ctx.service.pullRequest(projectId, repoId, num(id)));
  });
  r.post('/prs/:projectId/:repoId/:id/actions', async (req, res) => {
    const { projectId, repoId, id } = req.params;
    await req.ctx.service.prAction(projectId, repoId, num(id), req.body || {});
    res.json(await req.ctx.service.pullRequest(projectId, repoId, num(id)));
  });

  r.get('/workitems', async (req, res) => res.json(await req.ctx.service.workItems()));
  r.get('/workitems/:id', async (req, res) => res.json(await req.ctx.service.workItem(num(req.params.id))));
  r.post('/workitems/:id/actions', async (req, res) => {
    const id = num(req.params.id);
    await req.ctx.service.workItemAction(id, req.body || {});
    res.json(await req.ctx.service.workItem(id));
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
  r.post('/pipelines/queue', async (req, res) => {
    const { projectId, definitionId, branch } = req.body || {};
    res.json(await req.ctx.service.queueBuild(projectId, num(definitionId), branch));
  });

  r.get('/production', async (req, res) => res.json(await req.ctx.service.production()));
  r.get('/production/monitors', (req, res) => res.json(req.ctx.service.monitors().list()));
  r.put('/production/monitors', async (req, res) => {
    const saved = await req.ctx.service.monitors().save(req.body?.monitors);
    req.ctx.service.invalidate('builds');
    res.json(saved);
  });
  r.post('/production/test', async (req, res) => res.json(await req.ctx.service.monitors().test(req.body || {})));
  r.get('/releases', async (req, res) => res.json(await req.ctx.service.releases()));
  r.post('/releases/create', async (req, res) => {
    const { projectId, definitionId, description } = req.body || {};
    res.json(await req.ctx.service.createRelease(projectId, num(definitionId), description));
  });
  r.post('/releases/deploy', async (req, res) => {
    const { projectId, releaseId, environmentId, comment } = req.body || {};
    await req.ctx.service.deployReleaseStage(projectId, num(releaseId), num(environmentId), comment);
    res.json({ ok: true });
  });
  r.post('/approvals/:kind/:id', async (req, res) => {
    if (!['release', 'yaml'].includes(req.params.kind)) return res.status(400).json({ error: 'Unknown approval kind' });
    await req.ctx.service.decideApproval(req.params.kind, req.params.id, req.body || {});
    res.json({ ok: true });
  });

  r.get('/team', async (req, res) => res.json(await req.ctx.service.team()));
  r.get('/insights', async (req, res) => {
    const days = Math.min(180, Math.max(7, Number(req.query.days) || 30));
    res.json(await req.ctx.service.insights(days));
  });
  r.post('/changelog', async (req, res) => res.json(await req.ctx.service.changelog(req.body || {})));

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
