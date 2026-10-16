// Keel accounts for hosted mode: email + password, a role, and each
// person's own Azure DevOps token (encrypted). Stored in data/users.json.
//
// Roles: admin (everything, including users and production monitors),
// developer (all Azure DevOps actions), pm (work items, boards, approvals,
// running pipelines and releases; no pull request actions).
import crypto from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from './config.js';
import { decrypt, encrypt, getKey } from './secrets.js';
import { sharedJson } from './jsonfile.js';
import { DEMO_ORG_URL, orgKeyOf } from './orgs.js';

/** The organization a token is for when none is named: the one in AZDO_ORG_URL. */
export const primaryOrgKey = () => {
  const url = config.mock ? DEMO_ORG_URL : config.orgUrl;
  return url ? orgKeyOf(url) : 'default';
};

const scrypt = promisify(crypto.scrypt);
const DAY = 86_400_000;
const INVITE_DAYS = 7;

export const ROLES = ['admin', 'developer', 'pm'];
export const ROLE_LABELS = { admin: 'Admin', developer: 'Developer', pm: 'PM' };

export const PERMISSIONS = {
  admin: ['prs.write', 'workitems.write', 'approvals.decide', 'pipelines.run', 'releases.run', 'monitors.manage', 'users.manage', 'typecolors.manage'],
  developer: ['prs.write', 'workitems.write', 'approvals.decide', 'pipelines.run', 'releases.run'],
  pm: ['workitems.write', 'approvals.decide', 'pipelines.run', 'releases.run'],
};
export const can = (role, perm) => (PERMISSIONS[role] || []).includes(perm);

const err = (message, status = 400) => Object.assign(new Error(message), { status });
const normEmail = (e) => String(e || '').trim().toLowerCase();
const tokenHash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

export function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 10) throw err('Use a password of at least 10 characters.');
  if (pw.length > 200) throw err('That password is too long.');
}

export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(pw, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(pw, stored) {
  const [alg, salt, hash] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(String(pw), Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

export function createAccounts(file = path.join(config.dataDir, 'users.json'), { primaryOrg = primaryOrgKey() } = {}) {
  // Shared with any other server process: reread when changed, saved at once.
  const store = sharedJson(file, () => ({ users: [] }));
  let db = store.get();
  // Tokens are kept per organization (tokens[orgKey], identity in azdo[orgKey]).
  // A token saved before there were several organizations belongs to the primary one.
  store.update((d) => {
    for (const u of d.users || []) {
      if (u.pat !== undefined) {
        if (u.pat && !u.tokens?.[primaryOrg]) {
          u.tokens = { ...u.tokens, [primaryOrg]: u.pat };
          u.azdo = { ...u.azdo, [primaryOrg]: { id: u.azdoId || null, name: u.azdoName || null } };
        }
        delete u.pat;
        delete u.azdoId;
        delete u.azdoName;
      }
    }
  });
  db = store.get();
  const fresh = () => {
    db = store.get();
    if (!Array.isArray(db.users)) db.users = [];
    return db;
  };
  const save = () => store.save(db);
  const byId = (id) => db.users.find((u) => u.id === id) || null;
  const byEmail = (email) => db.users.find((u) => u.email === normEmail(email)) || null;
  const activeAdmins = () => db.users.filter((u) => u.role === 'admin' && !u.disabled && u.passwordHash);

  const status = (u) => (u.disabled ? 'disabled' : !u.passwordHash ? 'invited' : 'active');

  /** What the UI may see about an account (no hashes, tokens or invite secrets). */
  const publicUser = (u) => u && ({
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    status: status(u),
    hasToken: !!u.tokens?.[primaryOrg],
    azdoName: u.azdo?.[primaryOrg]?.name || null,
    orgTokens: Object.keys(u.tokens || {}),
    createdAt: u.createdAt,
    lastSeenAt: u.lastSeenAt || null,
    inviteExpiresAt: u.invite?.expiresAt || null,
  });

  function issueLink(u, purpose) {
    const token = crypto.randomBytes(32).toString('base64url');
    u.invite = { hash: tokenHash(token), purpose, expiresAt: new Date(Date.now() + INVITE_DAYS * DAY).toISOString() };
    save();
    return token;
  }

  function fromLink(token) {
    const h = tokenHash(token);
    const u = db.users.find((x) => x.invite?.hash === h);
    if (!u || Date.parse(u.invite.expiresAt) < Date.now() || u.disabled) throw err('This link is invalid or has expired. Ask your admin for a new one.', 404);
    return u;
  }

  // Async methods hash or verify first, then reread and change the account,
  // so a write by another process in the meantime isn't lost.
  return {
    needsSetup: () => (fresh(), !activeAdmins().length),
    list: () => (fresh(), db.users.map(publicUser).sort((a, b) => a.name.localeCompare(b.name))),
    get: (id) => (fresh(), publicUser(byId(id))),
    raw: (id) => (fresh(), byId(id)),
    publicUser,

    /** The very first admin (needs the setup code; see auth.js). */
    async createFirstAdmin({ email, name, password }) {
      if ((fresh(), activeAdmins().length)) throw err('Keel is already set up.', 409);
      checkPassword(password);
      const e = normEmail(email);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw err('Enter a valid email address.');
      const passwordHash = await hashPassword(password);
      if ((fresh(), activeAdmins().length)) throw err('Keel is already set up.', 409);
      const u = {
        id: crypto.randomUUID(), email: e, name: String(name || '').trim() || e, role: 'admin',
        passwordHash, pat: null, createdAt: new Date().toISOString(),
      };
      db.users = db.users.filter((x) => x.email !== e);
      db.users.push(u);
      save();
      return u;
    },

    async signIn(email, password) {
      const found = (fresh(), byEmail(email));
      // Same work and same answer whether or not the account exists.
      const ok = await verifyPassword(password, found?.passwordHash || 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(86));
      const u = (fresh(), byEmail(email));
      if (!u || !ok || !u.passwordHash || u.passwordHash !== found?.passwordHash) throw err('Email or password is incorrect.', 401);
      if (u.disabled) throw err('This account has been disabled. Ask your admin.', 403);
      u.lastSeenAt = new Date().toISOString();
      save();
      return u;
    },

    invite({ email, name, role }) {
      fresh();
      const e = normEmail(email);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw err('Enter a valid email address.');
      if (!ROLES.includes(role)) throw err('Pick a role: Admin, Developer or PM.');
      if (byEmail(e)?.passwordHash) throw err(`${e} already has an account.`, 409);
      let u = byEmail(e);
      if (!u) {
        u = { id: crypto.randomUUID(), email: e, name: String(name || '').trim() || e.split('@')[0], role, passwordHash: null, pat: null, createdAt: new Date().toISOString() };
        db.users.push(u);
      } else {
        Object.assign(u, { role, name: String(name || '').trim() || u.name });
      }
      return { user: publicUser(u), token: issueLink(u, 'invite') };
    },

    /** A password-reset link (also re-sends an expired invite). */
    resetLink(id) {
      const u = (fresh(), byId(id));
      if (!u) throw err('No such user.', 404);
      return issueLink(u, u.passwordHash ? 'reset' : 'invite');
    },

    peekLink(token) {
      const u = (fresh(), fromLink(token));
      return { email: u.email, name: u.name, role: u.role, purpose: u.invite.purpose };
    },

    async acceptLink(token, { name, password }) {
      fresh();
      fromLink(token);
      checkPassword(password);
      const passwordHash = await hashPassword(password);
      const u = (fresh(), fromLink(token));
      u.passwordHash = passwordHash;
      if (name && String(name).trim()) u.name = String(name).trim().slice(0, 80);
      u.invite = null;
      u.lastSeenAt = new Date().toISOString();
      save();
      return u;
    },

    async changePassword(id, current, next) {
      const found = (fresh(), byId(id));
      if (!found || !(await verifyPassword(current, found.passwordHash))) throw err('Your current password is incorrect.', 403);
      checkPassword(next);
      const passwordHash = await hashPassword(next);
      const u = (fresh(), byId(id));
      if (!u) throw err('No such user.', 404);
      u.passwordHash = passwordHash;
      save();
    },

    setToken(id, pat, identity, orgKey = primaryOrg) {
      const u = (fresh(), byId(id));
      if (!u) throw err('No such user.', 404);
      u.tokens = { ...u.tokens };
      u.azdo = { ...u.azdo };
      if (pat) {
        u.tokens[orgKey] = encrypt(getKey(), pat);
        u.azdo[orgKey] = { id: identity?.id || null, name: identity?.displayName || null };
      } else {
        delete u.tokens[orgKey];
        delete u.azdo[orgKey];
      }
      save();
    },
    tokenOf: (id, orgKey = primaryOrg) => {
      const u = (fresh(), byId(id));
      return u?.tokens?.[orgKey] ? decrypt(getKey(), u.tokens[orgKey]) : null;
    },
    /** Does this person have a token for the organization (the primary when not named)? */
    hasToken: (id, orgKey = primaryOrg) => {
      const u = (fresh(), byId(id));
      return !!u?.tokens?.[orgKey];
    },
    /** The Azure DevOps name a person's token for an organization belongs to. */
    azdoNameOf: (id, orgKey = primaryOrg) => {
      const u = (fresh(), byId(id));
      return u?.azdo?.[orgKey]?.name || null;
    },

    update(id, { role, disabled, name }, actorId) {
      const u = (fresh(), byId(id));
      if (!u) throw err('No such user.', 404);
      const losesAdmin = (role && role !== 'admin') || disabled === true;
      if (u.role === 'admin' && losesAdmin && activeAdmins().filter((a) => a.id !== id).length === 0) {
        throw err('Keel needs at least one active admin.', 409);
      }
      if (id === actorId && disabled) throw err("You can't disable your own account.", 409);
      if (role !== undefined) {
        if (!ROLES.includes(role)) throw err('Unknown role.');
        u.role = role;
      }
      if (disabled !== undefined) u.disabled = !!disabled;
      if (name !== undefined && String(name).trim()) u.name = String(name).trim().slice(0, 80);
      save();
      return publicUser(u);
    },

    remove(id, actorId) {
      const u = (fresh(), byId(id));
      if (!u) throw err('No such user.', 404);
      if (id === actorId) throw err("You can't remove your own account.", 409);
      if (u.role === 'admin' && activeAdmins().filter((a) => a.id !== id).length === 0) throw err('Keel needs at least one active admin.', 409);
      db.users = db.users.filter((x) => x.id !== id);
      save();
    },

    touch(id) {
      const u = (fresh(), byId(id));
      if (u && (!u.lastSeenAt || Date.now() - Date.parse(u.lastSeenAt) > 10 * 60_000)) {
        u.lastSeenAt = new Date().toISOString();
        save();
      }
    },
  };
}
