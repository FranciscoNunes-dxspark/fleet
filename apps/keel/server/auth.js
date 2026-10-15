// Sign-in with each person's own Azure DevOps PAT (AUTH_MODE=login).
//
// - The PAT is checked against the organization before it's accepted, then
//   stored encrypted (AES-256-GCM) with a key only this server has. It's never
//   sent back to the browser.
// - The browser gets a random session id in an HttpOnly, SameSite=Strict cookie
//   (Secure + __Host- prefix behind HTTPS). On disk we keep only its SHA-256.
// - Failed sign-ins are rate limited per IP; sessions slide for SESSION_DAYS
//   and end after 30 days regardless; a token Azure DevOps rejects ends the session.
// - Each user gets their own service (cache, settings, live updates), created on
//   first use and dropped after an hour idle.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { config } from './config.js';
import { createAzdoProvider } from './azdo/provider.js';
import { createService } from './service.js';
import { createSettingsStore, userSettingsFile } from './settings.js';
import { createWatcher } from './watcher.js';

const DAY = 86_400_000;
const MAX_SESSION_MS = 30 * DAY;
const IDLE_CONTEXT_MS = 60 * 60_000;
const FAIL_WINDOW_MS = 15 * 60_000;
const MAX_FAILS = 10;

// ------------------------------------------------------------------ crypto
function loadKey() {
  const secret = process.env.SESSION_SECRET;
  if (secret) {
    if (secret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');
    return crypto.createHash('sha256').update(secret).digest();
  }
  // No secret configured: generate one once and keep it next to the data.
  const file = path.join(config.dataDir, 'secret.key');
  try {
    return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
  } catch {
    const key = crypto.randomBytes(32);
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(file, key.toString('hex'), { mode: 0o600 });
    return key;
  }
}

export function encrypt(key, text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64url');
}

export function decrypt(key, blob) {
  const buf = Buffer.from(blob, 'base64url');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}

const hashId = (sid) => crypto.createHash('sha256').update(sid).digest('hex');

// ------------------------------------------------------------- rate limit
export function createLimiter({ max = MAX_FAILS, windowMs = FAIL_WINDOW_MS } = {}) {
  const fails = new Map(); // ip -> [timestamps]
  const recent = (ip, now) => (fails.get(ip) || []).filter((t) => now - t < windowMs);
  return {
    blockedFor(ip, now = Date.now()) {
      const list = recent(ip, now);
      return list.length >= max ? Math.ceil((windowMs - (now - list[0])) / 1000) : 0;
    },
    fail(ip, now = Date.now()) {
      fails.set(ip, [...recent(ip, now), now]);
    },
    reset(ip) {
      fails.delete(ip);
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
const cookieName = (secure) => (secure ? '__Host-shipdeck_session' : 'shipdeck_session');

// -------------------------------------------------------------- the module
export function createAuth() {
  const key = loadKey();
  const sessionDays = Math.max(1, Number(process.env.SESSION_DAYS) || 7);
  const sessionsFile = path.join(config.dataDir, 'sessions.json');
  const limiter = createLimiter();
  const contexts = new Map(); // userId -> { service, watcher, lastUsed }

  // sessionHash -> { userId, displayName, uniqueName, pat (encrypted), createdAt, expiresAt }
  let sessions = {};
  try {
    sessions = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
  } catch {
    sessions = {};
  }
  let saveTimer = null;
  const persist = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      fs.mkdirSync(config.dataDir, { recursive: true });
      fs.writeFileSync(sessionsFile, JSON.stringify(sessions, null, 1), { mode: 0o600 });
    }, 250);
  };

  function dropContext(userId) {
    const ctx = contexts.get(userId);
    if (ctx) ctx.watcher.close();
    contexts.delete(userId);
  }

  function contextFor(s) {
    let ctx = contexts.get(s.userId);
    if (!ctx) {
      const provider = createAzdoProvider({ orgUrl: config.orgUrl, pat: decrypt(key, s.pat) });
      const service = createService({ provider, settings: createSettingsStore(userSettingsFile(s.userId)) });
      ctx = { service, watcher: createWatcher(service), lastUsed: Date.now() };
      contexts.set(s.userId, ctx);
    }
    ctx.lastUsed = Date.now();
    return ctx;
  }

  function endSession(hash) {
    const s = sessions[hash];
    if (!s) return;
    delete sessions[hash];
    persist();
    if (!Object.values(sessions).some((x) => x.userId === s.userId)) dropContext(s.userId);
  }

  // Expired sessions and idle per-user caches are cleaned up every 10 minutes.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [h, s] of Object.entries(sessions)) if (s.expiresAt < now || s.createdAt + MAX_SESSION_MS < now) endSession(h);
    for (const [userId, ctx] of contexts) if (now - ctx.lastUsed > IDLE_CONTEXT_MS && !ctx.watcher.clientCount()) dropContext(userId);
  }, 10 * 60_000);
  sweep.unref?.();

  function current(req) {
    const sid = readCookie(req, cookieName(true)) || readCookie(req, cookieName(false));
    if (!sid) return null;
    const hash = hashId(sid);
    const s = sessions[hash];
    const now = Date.now();
    if (!s) return null;
    if (s.expiresAt < now || s.createdAt + MAX_SESSION_MS < now) {
      endSession(hash);
      return null;
    }
    // Sliding expiry, written at most hourly.
    const next = Math.min(now + sessionDays * DAY, s.createdAt + MAX_SESSION_MS);
    if (next - s.expiresAt > 60 * 60_000) {
      s.expiresAt = next;
      persist();
    }
    return { hash, s };
  }

  function setCookie(req, res, sid) {
    const secure = req.secure;
    res.cookie(cookieName(secure), sid, {
      httpOnly: true, secure, sameSite: 'strict', path: '/', maxAge: sessionDays * DAY,
    });
  }

  function clearCookies(res) {
    res.clearCookie(cookieName(true), { path: '/', secure: true, sameSite: 'strict', httpOnly: true });
    res.clearCookie(cookieName(false), { path: '/', sameSite: 'strict', httpOnly: true });
  }

  const router = express.Router();
  router.use(express.json({ limit: '16kb' }));

  router.get('/status', (req, res) => {
    const cur = current(req);
    res.json({
      mode: 'login',
      orgUrl: config.orgUrl,
      signedIn: !!cur,
      me: cur ? { displayName: cur.s.displayName, uniqueName: cur.s.uniqueName } : null,
    });
  });

  router.post('/login', async (req, res) => {
    if (req.get('x-shipdeck') !== '1') return res.status(403).json({ error: 'Missing x-shipdeck header' });
    const ip = req.ip;
    const wait = limiter.blockedFor(ip);
    if (wait) {
      res.set('Retry-After', String(wait));
      return res.status(429).json({ error: `Too many sign-in attempts. Try again in ${Math.ceil(wait / 60)} minute${wait > 60 ? 's' : ''}.` });
    }
    const pat = String(req.body?.pat || '').trim();
    if (!/^[A-Za-z0-9]{40,120}$/.test(pat)) {
      limiter.fail(ip);
      return res.status(400).json({ error: "That doesn't look like a personal access token. Paste the token itself (letters and numbers only)." });
    }
    let me;
    try {
      me = await createAzdoProvider({ orgUrl: config.orgUrl, pat }).me();
    } catch (err) {
      limiter.fail(ip);
      await new Promise((r) => setTimeout(r, 400)); // blunt timing/brute force a little more
      const status = err.code === 'token-rejected' ? 401 : 502;
      return res.status(status).json({
        error: status === 401
          ? `Azure DevOps didn't accept that token for ${config.orgUrl.replace(/^https?:\/\//, '')}. Check it hasn't expired and that it was created for this organization.`
          : `Couldn't reach Azure DevOps to check the token: ${err.message}`,
      });
    }
    limiter.reset(ip);
    const sid = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    sessions[hashId(sid)] = {
      userId: me.id,
      displayName: me.displayName,
      uniqueName: me.uniqueName,
      pat: encrypt(key, pat),
      createdAt: now,
      expiresAt: now + sessionDays * DAY,
    };
    persist();
    // A fresh token replaces whatever this user's service was using.
    dropContext(me.id);
    setCookie(req, res, sid);
    res.json({ me: { displayName: me.displayName, uniqueName: me.uniqueName } });
  });

  router.post('/logout', (req, res) => {
    if (req.get('x-shipdeck') !== '1') return res.status(403).json({ error: 'Missing x-shipdeck header' });
    const cur = current(req);
    if (cur) endSession(cur.hash);
    clearCookies(res);
    res.json({ ok: true });
  });

  /** For every other /api route: attach the signed-in user's context or refuse. */
  function requireUser(req, res, next) {
    const cur = current(req);
    if (!cur) return res.status(401).json({ error: 'Sign in to continue.', code: 'signin-required' });
    try {
      req.ctx = contextFor(cur.s);
    } catch {
      // Unreadable token (e.g. SESSION_SECRET changed): start over.
      endSession(cur.hash);
      return res.status(401).json({ error: 'Your session has ended. Sign in again.', code: 'signin-required' });
    }
    // If Azure DevOps rejects this user's token later, end the session.
    req.onTokenRejected = () => endSession(cur.hash);
    return next();
  }

  return { router, requireUser };
}
