// Sign-in mode keeps a person's Azure DevOps token when one call is refused for a scope the token
// lacks (Azure DevOps answers 401 then too), and asks for a new one only when the token itself stopped working.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The server's config reads these on import, so they come first.
const dataDir = mkdtempSync(join(tmpdir(), 'keel-token-'));
Object.assign(process.env, { AZDO_MOCK: '1', AUTH_MODE: 'login', DATA_DIR: dataDir, ADMIN_SETUP_CODE: 'token-test-code', SESSION_SECRET: 't'.repeat(48) });

const express = (await import('express')).default;
const { createAuth } = await import('../server/auth.js');
const { apiRouter } = await import('../server/routes.js');

let server;
let url;
let cookie;
const call = async (path, { method = 'GET', body } = {}) => {
  const res = await fetch(`${url}/api${path}`, { method, headers: { 'x-keel': '1', 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body && JSON.stringify(body) });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  return { status: res.status, data: await res.json() };
};

before(async () => {
  const auth = createAuth();
  const app = express();
  app.use('/api/auth', auth.router);
  // As Azure DevOps answers a call outside the token's scopes: the client's token-rejected error.
  const refuseRepos = (req, res, next) => {
    req.ctx.service.repos = async () => {
      throw Object.assign(new Error('Azure DevOps rejected the token: it may have expired, been revoked, or lack the needed scopes.'), { status: 401, code: 'token-rejected' });
    };
    next();
  };
  app.use('/api', auth.requireUser, refuseRepos, apiRouter());
  await new Promise((done) => {
    server = app.listen(0, '127.0.0.1', done);
  });
  url = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await call('/auth/setup', { method: 'POST', body: { code: 'token-test-code', name: 'Ana Lead', email: 'ana@example.com', password: 'correct horse battery' } })).status, 200);
  // On demo data any token-shaped value is accepted, and still says who it belongs to afterwards.
  assert.equal((await call('/auth/token', { method: 'POST', body: { pat: 'a'.repeat(52) } })).status, 200);
});
after(() => {
  server?.closeAllConnections?.();
  server?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('A call refused for its scope keeps the token and says why', async () => {
  const refused = await call('/repos');
  assert.equal(refused.status, 403);
  assert.equal(refused.data.code, undefined, "the browser mustn't ask for the token again");
  assert.match(refused.data.error, /scope/);
  assert.equal((await call('/auth/status')).data.needsToken, false);
  assert.equal((await call('/prs')).status, 200, 'the rest keeps working');
});
