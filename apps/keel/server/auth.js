// Accounts and sign-in for hosted mode (AUTH_MODE=login).
//
// - People sign in with email + password (scrypt hashes, see accounts.js).
//   Admins invite others with a one-time link; the very first admin is created
//   with a setup code printed in the server log (or ADMIN_SETUP_CODE).
// - After signing in, each person links their own Azure DevOps token once. It's
//   checked against the organization, stored encrypted, never sent back to the
//   browser, and everything they do in Azure DevOps is recorded under their name.
// - Roles (admin / developer / pm) are enforced on the server for every action.
// - The browser holds only a random session id in an HttpOnly, SameSite=Strict
//   cookie (Secure + __Host- prefix behind HTTPS); on disk we keep its SHA-256.
// - Sign-in is rate limited per IP and per email; sessions slide for
//   SESSION_DAYS and end after 30 days regardless.
// - Each person gets their own service (cache, settings, live updates), created
//   on first use and dropped after an hour idle.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { config } from './config.js';
import { createAzdoProvider } from './azdo/provider.js';
import { createMockProvider } from './mock/provider.js';
import { createService } from './service.js';
import { createSettingsStore, userSettingsFile } from './settings.js';
import { createWatcher } from './watcher.js';
import { ROLE_LABELS, can, createAccounts } from './accounts.js';
import { sharedJson } from './jsonfile.js';
import { createOrgStore } from './orgs.js';
import { createMultiService } from './multiorg.js';
import { createMockVariant } from './mock/variant.js';

const DAY = 86_400_000;
const MAX_SESSION_MS = 30 * DAY;
const IDLE_CONTEXT_MS = 60 * 60_000;
const FAIL_WINDOW_MS = 15 * 60_000;
const MAX_FAILS = 10;

// Encryption lives in secrets.js (shared with Azure API keys); re-exported for tests.
export { encrypt, decrypt } from './secrets.js';

const hashId = (sid) => crypto.createHash('sha256').update(sid).digest('hex');

// ------------------------------------------------------------- rate limit
export function createLimiter({ max = MAX_FAILS, windowMs = FAIL_WINDOW_MS } = {}) {
  const fails = new Map(); // key -> [timestamps]
  const recent = (k, now) => (fails.get(k) || []).filter((t) => now - t < windowMs);
  return {
    blockedFor(k, now = Date.now()) {
      const list = recent(k, now);
      return list.length >= max ? Math.ceil((windowMs - (now - list[0])) / 1000) : 0;
    },
    fail(k, now = Date.now()) {
      fails.set(k, [...recent(k, now), now]);
    },
    reset(k) {
      fails.delete(k);
    },
  };
}

// -------------------------------------------------------------- cookies
function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
const cookieName = (secure) => (secure ? '__Host-keel_session' : 'keel_session');

// -------------------------------------------------------------- the module
export function createAuth({ monitoring = null } = {}) {
  const sessionDays = Math.max(1, Number(process.env.SESSION_DAYS) || 7);
  // Demo mode keeps its accounts apart from real ones.
  const suffix = config.mock ? '.mock' : '';
  const sessionsFile = path.join(config.dataDir, `sessions${suffix}.json`);
  const orgStore = createOrgStore();
  const primaryOrg = () => orgStore.primary();
  const accounts = createAccounts(path.join(config.dataDir, `users${suffix}.json`), { primaryOrg: primaryOrg().key });
  const orgUrl = primaryOrg().url;
  // Demo mode: any token-shaped value "connects"; other demo organizations are the demo data renamed.
  const providerFor = (pat, org = primaryOrg()) => (config.mock
    ? (org.primary ? createMockProvider() : createMockVariant())
    : createAzdoProvider({ orgUrl: org.url, pat }));
  const ipLimiter = createLimiter();
  const emailLimiter = createLimiter({ max: 5 });
  const contexts = new Map(); // accountId -> { service, watcher, lastUsed }

  // First run: no admin yet. The setup code proves you can read the server log.
  // A generated code is kept in data/ so it stays the same across restarts
  // and is the same in every server process, until the first admin exists.
  const setupCodeFile = path.join(config.dataDir, `setup-code${suffix}.txt`);
  const setupCode = () => {
    if (process.env.ADMIN_SETUP_CODE) return process.env.ADMIN_SETUP_CODE;
    const read = () => {
      try {
        const saved = fs.readFileSync(setupCodeFile, 'utf8').trim();
        return /^[0-9a-f]{12}$/.test(saved) ? saved : null;
      } catch {
        return null;
      }
    };
    const saved = read();
    if (saved) return saved;
    fs.mkdirSync(config.dataDir, { recursive: true });
    try {
      // 'wx' fails if another process created it first; then use theirs.
      fs.writeFileSync(setupCodeFile, crypto.randomBytes(6).toString('hex'), { mode: 0o600, flag: 'wx' });
    } catch {
      // created by another process
    }
    return read();
  };
  const announceSetup = () => {
    if (accounts.needsSetup()) {
      console.log(`\n  Keel has no admin yet. Open it in a browser and use this setup code:\n\n      ${setupCode()}\n`);
    }
  };

  // sessionHash -> { userId, createdAt, expiresAt }, shared with any other
  // server process. Old-style sessions (from token-only sign-in) carry no
  // account and are dropped.
  const sessionStore = sharedJson(sessionsFile, () => ({}));
  endSessions((s) => s.pat || !accounts.raw(s.userId));

  function dropContext(userId) {
    const ctx = contexts.get(userId);
    if (ctx) ctx.watcher.close();
    contexts.delete(userId);
  }

  // Rebuilt when the organizations, or this person's tokens, change.
  const contextSignature = (user) => `${orgStore.signature()}|${orgStore.all().filter((o) => accounts.hasToken(user.id, o.key)).map((o) => o.key).join(',')}`;

  function contextFor(user) {
    let ctx = contexts.get(user.id);
    const sig = contextSignature(user);
    if (ctx && ctx.sig !== sig) {
      dropContext(user.id);
      ctx = null;
    }
    if (!ctx) {
      const settings = createSettingsStore(userSettingsFile(user.id)); // one settings file for every organization
      const entries = orgStore.all()
        .filter((org) => accounts.hasToken(user.id, org.key))
        .map((org) => ({
          org,
          service: createService({ provider: providerFor(accounts.tokenOf(user.id, org.key), org), settings, monitoring: org.primary ? monitoring : null, org }),
        }));
      const service = createMultiService(entries);
      ctx = { service, watcher: createWatcher(service), lastUsed: Date.now(), sig };
      contexts.set(user.id, ctx);
    }
    ctx.lastUsed = Date.now();
    ctx.role = user.role;
    ctx.user = accounts.publicUser(user);
    return ctx;
  }

  function startSession(req, res, user) {
    const sid = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    sessionStore.update((all) => {
      all[hashId(sid)] = { userId: user.id, createdAt: now, expiresAt: now + sessionDays * DAY };
    });
    const secure = req.secure;
    res.cookie(cookieName(secure), sid, { httpOnly: true, secure, sameSite: 'strict', path: '/', maxAge: sessionDays * DAY });
  }

  function endSessions(predicate) {
    const all = sessionStore.get();
    let changed = false;
    for (const [h, s] of Object.entries(all)) {
      if (predicate(s, h)) {
        delete all[h];
        changed = true;
      }
    }
    if (changed) sessionStore.save(all);
  }

  function clearCookies(res) {
    res.clearCookie(cookieName(true), { path: '/', secure: true, sameSite: 'strict', httpOnly: true });
    res.clearCookie(cookieName(false), { path: '/', sameSite: 'strict', httpOnly: true });
  }

  // Expired sessions and idle per-user caches are cleaned up every 10 minutes.
  const sweep = setInterval(() => {
    const now = Date.now();
    endSessions((s) => s.expiresAt < now || s.createdAt + MAX_SESSION_MS < now);
    for (const [userId, ctx] of contexts) if (now - ctx.lastUsed > IDLE_CONTEXT_MS && !ctx.watcher.clientCount()) dropContext(userId);
  }, 10 * 60_000);
  sweep.unref?.();

  /** The signed-in account for this request, or null. */
  function current(req) {
    const sid = readCookie(req, cookieName(true)) || readCookie(req, cookieName(false));
    if (!sid) return null;
    const hash = hashId(sid);
    const s = sessionStore.get()[hash];
    const now = Date.now();
    if (!s) return null;
    const user = accounts.raw(s.userId);
    if (!user || user.disabled || s.expiresAt < now || s.createdAt + MAX_SESSION_MS < now) {
      endSessions((_, h) => h === hash);
      return null;
    }
    const next = Math.min(now + sessionDays * DAY, s.createdAt + MAX_SESSION_MS);
    if (next - s.expiresAt > 60 * 60_000) {
      s.expiresAt = next;
      sessionStore.save();
    }
    accounts.touch(user.id);
    return { hash, user };
  }

  const appHeader = (req, res, next) => (req.method === 'GET' || req.get('x-keel') === '1'
    ? next()
    : res.status(403).json({ error: 'Missing x-keel header' }));

  const throttle = (req, res, emailKey) => {
    const wait = Math.max(ipLimiter.blockedFor(req.ip), emailKey ? emailLimiter.blockedFor(emailKey) : 0);
    if (!wait) return false;
    res.set('Retry-After', String(wait));
    res.status(429).json({ error: `Too many attempts. Try again in ${Math.ceil(wait / 60)} minute${wait > 60 ? 's' : ''}.` });
    return true;
  };
  const failed = (req, emailKey) => {
    ipLimiter.fail(req.ip);
    if (emailKey) emailLimiter.fail(emailKey);
  };

  const send = (res, fn) => Promise.resolve().then(fn).catch((err) => {
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    if (status >= 500) console.error('[auth]', err);
    res.status(status).json({ error: err.message || 'Unexpected error' });
  });

  // ------------------------------------------------------------- /api/auth
  const router = express.Router();
  router.use(express.json({ limit: '16kb' }), appHeader);

  router.get('/status', (req, res) => {
    const cur = current(req);
    res.json({
      mode: 'login',
      orgUrl,
      setupRequired: accounts.needsSetup(),
      signedIn: !!cur,
      user: cur ? accounts.publicUser(cur.user) : null,
      needsToken: cur ? !accounts.hasToken(cur.user.id) : false,
    });
  });

  router.post('/setup', (req, res) => send(res, async () => {
    if (throttle(req, res)) return;
    if (!accounts.needsSetup()) throw Object.assign(new Error('Keel is already set up. Sign in instead.'), { status: 409 });
    const code = String(req.body?.code || '').trim();
    if (!code || !crypto.timingSafeEqual(Buffer.from(tokenPad(code)), Buffer.from(tokenPad(setupCode() || '')))) {
      failed(req);
      throw Object.assign(new Error('That setup code is wrong. It is printed in the server log when Keel starts.'), { status: 403 });
    }
    const user = await accounts.createFirstAdmin(req.body || {});
    fs.rm(setupCodeFile, { force: true }, () => {});
    startSession(req, res, user);
    res.json({ user: accounts.publicUser(user) });
  }));

  router.post('/login', (req, res) => send(res, async () => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (throttle(req, res, email)) return;
    try {
      const user = await accounts.signIn(email, String(req.body?.password || ''));
      ipLimiter.reset(req.ip);
      emailLimiter.reset(email);
      startSession(req, res, user);
      res.json({ user: accounts.publicUser(user), needsToken: !accounts.hasToken(user.id) });
    } catch (err) {
      if (err.status === 401) failed(req, email);
      throw err;
    }
  }));

  router.post('/logout', (req, res) => {
    const cur = current(req);
    if (cur) endSessions((_, h) => h === cur.hash);
    clearCookies(res);
    res.json({ ok: true });
  });

  // Invite / password-reset links (no session needed).
  router.get('/link/:token', (req, res) => send(res, () => {
    if (throttle(req, res)) return;
    try {
      res.json(accounts.peekLink(req.params.token));
    } catch (err) {
      failed(req);
      throw err;
    }
  }));

  router.post('/link/:token', (req, res) => send(res, async () => {
    if (throttle(req, res)) return;
    try {
      const user = await accounts.acceptLink(req.params.token, req.body || {});
      endSessions((s) => s.userId === user.id); // a reset signs out other devices
      startSession(req, res, user);
      res.json({ user: accounts.publicUser(user), needsToken: !accounts.hasToken(user.id) });
    } catch (err) {
      if (err.status === 404) failed(req);
      throw err;
    }
  }));

  // Signed-in account management.
  const signedIn = (req, res, next) => {
    const cur = current(req);
    if (!cur) return res.status(401).json({ error: 'Sign in to continue.', code: 'signin-required' });
    req.account = cur.user;
    req.sessionHash = cur.hash;
    return next();
  };

  /** Organizations and whether this person has linked a token for each. */
  router.get('/orgs', signedIn, (req, res) => {
    res.json(orgStore.all().map((o) => ({ ...o, connected: accounts.hasToken(req.account.id, o.key), azdoName: accounts.azdoNameOf(req.account.id, o.key) })));
  });

  router.post('/token', signedIn, (req, res) => send(res, async () => {
    const org = req.body?.org ? orgStore.get(String(req.body.org)) : primaryOrg();
    if (!org) throw Object.assign(new Error('No such organization.'), { status: 404 });
    const pat = String(req.body?.pat || '').trim();
    if (!/^[A-Za-z0-9]{40,120}$/.test(pat)) throw Object.assign(new Error("That doesn't look like a personal access token. Paste the token itself (letters and numbers only)."), { status: 400 });
    let me;
    try {
      me = await providerFor(pat, org).me();
    } catch (err) {
      throw Object.assign(new Error(err.code === 'token-rejected'
        ? `Azure DevOps didn't accept that token for ${org.url.replace(/^https?:\/\//, '')}. Check it hasn't expired and that it was created for this organization.`
        : `Couldn't reach Azure DevOps to check the token: ${err.message}`), { status: err.code === 'token-rejected' ? 400 : 502 });
    }
    accounts.setToken(req.account.id, pat, me, org.key);
    dropContext(req.account.id);
    res.json({ user: accounts.get(req.account.id), azdoName: me.displayName, org: org.key });
  }));

  router.delete('/token', signedIn, (req, res) => {
    const org = req.query.org ? orgStore.get(String(req.query.org)) : primaryOrg();
    accounts.setToken(req.account.id, null, null, org?.key);
    dropContext(req.account.id);
    res.json({ ok: true });
  });

  router.post('/password', signedIn, (req, res) => send(res, async () => {
    await accounts.changePassword(req.account.id, String(req.body?.current || ''), String(req.body?.next || ''));
    // Other devices are signed out; this one stays signed in.
    endSessions((s, h) => s.userId === req.account.id && h !== req.sessionHash);
    res.json({ ok: true });
  }));

  // ------------------------------------------------------- /api/admin/users
  const admin = express.Router();
  admin.use(express.json({ limit: '16kb' }), appHeader, signedIn, (req, res, next) => (can(req.account.role, 'users.manage')
    ? next()
    : res.status(403).json({ error: 'Only admins can manage users.' })));

  const linkUrl = (req, token) => `${req.protocol}://${req.get('host')}/invite/${token}`;

  admin.get('/', (req, res) => res.json({ users: accounts.list(), roles: ROLE_LABELS }));
  admin.post('/', (req, res) => send(res, () => {
    const { user, token } = accounts.invite(req.body || {});
    res.status(201).json({ user, link: linkUrl(req, token) });
  }));
  admin.patch('/:id', (req, res) => send(res, () => {
    const user = accounts.update(req.params.id, req.body || {}, req.account.id);
    if (user.status === 'disabled') {
      endSessions((s) => s.userId === user.id);
      dropContext(user.id);
    }
    res.json({ user });
  }));
  admin.post('/:id/link', (req, res) => send(res, () => {
    const token = accounts.resetLink(req.params.id);
    res.json({ link: linkUrl(req, token) });
  }));
  admin.delete('/:id', (req, res) => send(res, () => {
    accounts.remove(req.params.id, req.account.id);
    endSessions((s) => s.userId === req.params.id);
    dropContext(req.params.id);
    try {
      fs.rmSync(userSettingsFile(req.params.id), { force: true });
    } catch {
      // settings file may not exist
    }
    res.json({ ok: true });
  }));

  // ------------------------------------------- every other /api route
  /** Attach the signed-in person's context (needs a linked token) or refuse. */
  function requireUser(req, res, next) {
    const cur = current(req);
    if (!cur) return res.status(401).json({ error: 'Sign in to continue.', code: 'signin-required' });
    if (!accounts.hasToken(cur.user.id)) return res.status(409).json({ error: 'Connect your Azure DevOps account to continue.', code: 'token-required' });
    try {
      req.ctx = contextFor(cur.user);
    } catch {
      // Unreadable token (e.g. SESSION_SECRET changed): ask for it again.
      accounts.setToken(cur.user.id, null, null);
      return res.status(409).json({ error: 'Connect your Azure DevOps account again.', code: 'token-required' });
    }
    // If Azure DevOps rejects this person's token, forget it so they're asked for a new one.
    req.onTokenRejected = () => {
      accounts.setToken(cur.user.id, null, null);
      dropContext(cur.user.id);
    };
    return next();
  }

  /** The service of an account with a linked token, for background work (channel posts); null otherwise. */
  function serviceFor(userId) {
    const user = userId && accounts.raw(userId);
    if (!user || user.disabled || !accounts.hasToken(user.id)) return null;
    try {
      return contextFor(user).service;
    } catch {
      return null;
    }
  }

  return { router, adminRouter: admin, requireUser, announceSetup, serviceFor };
}

/** Pads codes to equal length for a constant-time compare. */
function tokenPad(s) {
  return String(s).padEnd(64, '\0').slice(0, 64);
}
