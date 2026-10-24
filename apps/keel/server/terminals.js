// Signing the terminal app in with a Keel account (hosted mode), the way `gh auth login` does:
//
// 1. `keel login` asks for a login: a secret device code it keeps, and a short user code it shows.
// 2. You open <Keel>/terminal in a browser where you're signed in, type that code and allow it.
//    Typing it (rather than following a link that carries it) is what stops someone from
//    sending you a link to approve a login they started.
// 3. The terminal app, asking with its device code every few seconds, gets its own token.
//
// Tokens act as the person in /api (never the account pages), are kept as SHA-256 hashes, end
// after 90 days unused, and are listed in Settings → Your account, where each can be signed out.
// Shared by every server process (sharedJson), as sessions are.
import crypto from 'node:crypto';
import { sharedJson } from './jsonfile.js';

const MINUTE = 60_000;
const DAY = 86_400_000;
export const LOGIN_MINUTES = 10;
export const POLL_SECONDS = 3;
export const TOKEN_IDLE_DAYS = 90;
export const TOKEN_PREFIX = 'keel_';
// No vowels, so a code never spells a word, and nothing that reads like another character.
const CODE_LETTERS = 'BCDFGHJKLMNPQRSTVWXZ';

const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const err = (message, status = 400, code) => Object.assign(new Error(message), { status, ...(code ? { code } : {}) });

/** A user code as typed: "wxyz bcdf" or "WXYZ-BCDF" → "WXYZBCDF". */
export const normalizeCode = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z]/g, '');

/** "WXYZBCDF" → "WXYZ-BCDF", as the terminal shows it. */
export const showCode = (code) => `${code.slice(0, 4)}-${code.slice(4)}`;

function newUserCode() {
  const bytes = crypto.randomBytes(8);
  return [...bytes].map((b) => CODE_LETTERS[b % CODE_LETTERS.length]).join('');
}

/** `name` and `ip` describe the terminal for the person approving it; both are cut to size. */
const clip = (s, n) => String(s ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, n);

export function createTerminals(file, { now = Date.now } = {}) {
  const store = sharedJson(file, () => ({ logins: {}, tokens: {} }));

  // Expired logins and long-unused tokens go whenever anything is written.
  const prune = (all) => {
    const t = now();
    all.logins ??= {};
    all.tokens ??= {};
    for (const [k, l] of Object.entries(all.logins)) if (l.expiresAt < t) delete all.logins[k];
    for (const [k, tok] of Object.entries(all.tokens)) if (tok.lastUsedAt + TOKEN_IDLE_DAYS * DAY < t) delete all.tokens[k];
  };
  const pending = (userCode) => {
    const code = normalizeCode(userCode);
    const all = store.get();
    const t = now();
    const found = Object.entries(all.logins ?? {}).find(([, l]) => l.userCode === code && l.expiresAt >= t && l.status === 'pending');
    if (!found) throw err("That code isn't one Keel is waiting for. Check it against your terminal, or run keel login again: codes last 10 minutes.", 404);
    return found;
  };

  return {
    /** Starts a login: the device code stays with the terminal, the user code is typed in the browser. */
    start({ name, ip } = {}) {
      const deviceCode = crypto.randomBytes(32).toString('base64url');
      const t = now();
      let userCode;
      store.update((all) => {
        prune(all);
        const taken = new Set(Object.values(all.logins).map((l) => l.userCode));
        do userCode = newUserCode();
        while (taken.has(userCode));
        all.logins[hash(deviceCode)] = { userCode, name: clip(name, 80) || 'A terminal', ip: clip(ip, 64), createdAt: t, expiresAt: t + LOGIN_MINUTES * MINUTE, status: 'pending' };
      });
      return { deviceCode, userCode: showCode(userCode), expiresIn: LOGIN_MINUTES * 60, interval: POLL_SECONDS };
    },

    /** What the browser shows before you allow it: which terminal asked, and when. */
    peek(userCode) {
      const [, l] = pending(userCode);
      return { userCode: showCode(l.userCode), name: l.name, ip: l.ip, createdAt: new Date(l.createdAt).toISOString() };
    },

    /** You allowed (or refused) the login with this user code. */
    decide(userCode, userId, allow) {
      const [key] = pending(userCode);
      store.update((all) => {
        const l = all.logins[key];
        if (!l) return;
        l.status = allow ? 'approved' : 'denied';
        l.userId = allow ? userId : null;
      });
    },

    /**
     * The terminal asking how its login went: 'pending', 'denied' or 'expired', or once allowed,
     * `{ status: 'approved', token, userId }`. The token is handed out once; the login is gone after.
     */
    poll(deviceCode) {
      const key = hash(deviceCode);
      const t = now();
      return store.update((all) => {
        const l = all.logins?.[key];
        if (!l || l.expiresAt < t) {
          if (l) delete all.logins[key];
          return { status: 'expired' };
        }
        if (l.status === 'pending') return { status: 'pending' };
        delete all.logins[key];
        if (l.status !== 'approved') return { status: 'denied' };
        const token = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
        all.tokens ??= {};
        all.tokens[hash(token)] = { id: crypto.randomBytes(8).toString('hex'), userId: l.userId, name: l.name, ip: l.ip, createdAt: t, lastUsedAt: t };
        return { status: 'approved', token, userId: l.userId };
      });
    },

    /** The token's sign-in ({ id, userId, name }), or null. Use is noted at most hourly, so requests don't each write the file. */
    verify(token) {
      if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX)) return null;
      const key = hash(token);
      const tok = store.get().tokens?.[key];
      const t = now();
      if (!tok || tok.lastUsedAt + TOKEN_IDLE_DAYS * DAY < t) return null;
      if (t - tok.lastUsedAt > 60 * MINUTE) {
        store.update((all) => {
          if (all.tokens?.[key]) all.tokens[key].lastUsedAt = t;
        });
      }
      return { id: tok.id, userId: tok.userId, name: tok.name };
    },

    /** Someone's terminal sign-ins, most recently used first. */
    list(userId) {
      const t = now();
      return Object.values(store.get().tokens ?? {})
        .filter((tok) => tok.userId === userId && tok.lastUsedAt + TOKEN_IDLE_DAYS * DAY >= t)
        .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
        .map((tok) => ({ id: tok.id, name: tok.name, ip: tok.ip, createdAt: new Date(tok.createdAt).toISOString(), lastUsedAt: new Date(tok.lastUsedAt).toISOString() }));
    },

    /** Signs out one of `userId`'s terminals by its id (false when there's no such one). */
    revoke(userId, id) {
      return store.update((all) => {
        prune(all);
        const key = Object.keys(all.tokens).find((k) => all.tokens[k].id === id && all.tokens[k].userId === userId);
        if (key) delete all.tokens[key];
        return !!key;
      });
    },

    /** `keel logout`: the token signs itself out. */
    revokeToken(token) {
      store.update((all) => {
        prune(all);
        delete all.tokens[hash(token)];
      });
    },

    /** Every terminal of this person (a new password, a disabled or removed account). */
    revokeAll(userId) {
      store.update((all) => {
        prune(all);
        for (const [k, tok] of Object.entries(all.tokens)) if (tok.userId === userId) delete all.tokens[k];
      });
    },
  };
}
