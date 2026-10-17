// Connection tokens for the Claude connector (see mcp.js). Each person makes
// their own in Settings → Claude and pastes it into Claude; Claude then acts in
// Keel as that person, with their role and their Azure DevOps token.
//
// - A token is shown once. On disk we keep its SHA-256, a name and when it was
//   last used (data/mcp-tokens.json, shared with other server processes).
// - Locally (no sign-in) tokens belong to "local"; with sign-in, to the account.
//   Removing an account removes its tokens; a disabled account's tokens stop working.
import crypto from 'node:crypto';
import path from 'node:path';
import { config } from './config.js';
import { sharedJson } from './jsonfile.js';

const MAX_PER_PERSON = 10;
const TOUCH_EVERY_MS = 10 * 60_000;
const TOKEN_RE = /^keel_[A-Za-z0-9_-]{43}$/;

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const err = (message, status = 400) => Object.assign(new Error(message), { status });

export const defaultMcpTokenFile = () => path.join(config.dataDir, `mcp-tokens${config.mock ? '.mock' : ''}.json`);

export function createMcpTokens(file = defaultMcpTokenFile()) {
  const store = sharedJson(file, () => ({ tokens: [] }));
  const all = () => {
    const d = store.get();
    return Array.isArray(d.tokens) ? d.tokens : [];
  };
  // Never hand out the hash.
  const view = ({ hash, userId, ...rest }) => rest;

  return {
    list: (userId) => all().filter((t) => t.userId === userId).map(view),

    /** A new token for `userId`: { token (shown once), entry }. */
    create(userId, name) {
      if (!userId) throw err('No account to create a token for.');
      if (all().filter((t) => t.userId === userId).length >= MAX_PER_PERSON) {
        throw err(`You can have at most ${MAX_PER_PERSON} Claude connections. Remove one you no longer use.`, 409);
      }
      const token = `keel_${crypto.randomBytes(32).toString('base64url')}`;
      const entry = {
        id: crypto.randomBytes(6).toString('hex'),
        userId,
        name: String(name || '').trim().slice(0, 60) || 'Claude',
        hash: sha256(token),
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
      };
      store.update((d) => {
        d.tokens = [...(Array.isArray(d.tokens) ? d.tokens : []), entry];
      });
      return { token, entry: view(entry) };
    },

    revoke(userId, id) {
      const found = store.update((d) => {
        const before = (d.tokens || []).length;
        d.tokens = (d.tokens || []).filter((t) => !(t.userId === userId && t.id === id));
        return d.tokens.length !== before;
      });
      if (!found) throw err('No such Claude connection.', 404);
    },

    removeUser(userId) {
      if (!all().some((t) => t.userId === userId)) return;
      store.update((d) => {
        d.tokens = (d.tokens || []).filter((t) => t.userId !== userId);
      });
    },

    /** The token's entry ({ id, userId, name, ... }), or null. Records when it was last used. */
    resolve(token) {
      if (!TOKEN_RE.test(String(token || ''))) return null;
      const hash = sha256(token);
      const entry = all().find((t) => t.hash === hash);
      if (!entry) return null;
      if (!entry.lastUsedAt || Date.now() - Date.parse(entry.lastUsedAt) > TOUCH_EVERY_MS) {
        store.update((d) => {
          const t = (d.tokens || []).find((x) => x.hash === hash);
          if (t) t.lastUsedAt = new Date().toISOString();
        });
      }
      return { id: entry.id, userId: entry.userId, name: entry.name };
    },
  };
}
