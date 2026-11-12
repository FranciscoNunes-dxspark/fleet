// Claude proposes, you press ↵. `fleet mcp`'s `propose` tool leaves a line for one app's prompt, with
// why, as one JSON file in the family's folder (<familyDir>/proposals/<id>.json); the host reads that
// folder every few seconds, shows what's waiting in the bar and in a panel (the prefix and P), and ↵
// there hands the line to its app as a runbook step is: typed into its prompt, never run. What became
// of it (handed or dismissed, and when) is written back into the same file, which `proposal_status`
// reads. A proposal is a suggestion only: nothing runs until a person presses ↵ in the app itself.
//
// The rules are the family's for anything Claude writes: an app of the family, a slash command (never a
// `!` shell, SQL or git line), one line of bounded length, and secrets masked as the activity log's are.
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FAMILY, familyDir, redactSecrets } from '@fleet/kit/family.js';

/** The apps with a prompt that takes slash commands: Helm has none (a script editor), so nothing is proposed to it. */
export const PROMPT_APPS = FAMILY.filter((a) => a !== 'helm');

export const MAX_LINE = 500;
export const MAX_WHY = 1000;
/** How long a proposal waits: older ones drop off (the panel, the bar, and their files). */
export const MAX_AGE = 60 * 60_000;

const ID = /^[a-z0-9]+-[a-f0-9]{6}$/;

export const proposalsDir = (home = familyDir()) => join(home, 'proposals');

/**
 * Checks what Claude proposed: { ok: true, proposal: { app, line, why } } or { ok: false, error }, the
 * error saying what to change. `ids` are the apps a proposal may name (the family's with a prompt).
 */
export function checkProposal({ app, line, why } = {}, { ids = PROMPT_APPS } = {}) {
  const to = String(app ?? '').trim().toLowerCase();
  if (!ids.includes(to)) return { ok: false, error: `"${app ?? ''}" isn't an app of the family: ${ids.join(', ')}.` };
  const text = String(line ?? '').trim();
  if (/[\r\n]/.test(text)) return { ok: false, error: 'The line must be one line: it is typed into the app\'s prompt as it is.' };
  if (!text.startsWith('/')) return { ok: false, error: `The line must be a slash command for ${to}'s prompt (it starts with /).` };
  // A `!` word is a shell command, raw SQL or git in the apps' prompts: never proposed, even inside a
  // command. `!=` is a comparison (a KQL filter), not one.
  if (/(^|\s)!(?!=)/.test(text)) return { ok: false, error: 'A line with a ! command (a shell, raw SQL or git) is never proposed: propose the slash command that does it.' };
  if (text.length > MAX_LINE) return { ok: false, error: `The line is ${text.length} characters: at most ${MAX_LINE}.` };
  const reason = String(why ?? '').replace(/\s+/g, ' ').trim();
  if (!reason) return { ok: false, error: 'Say why (`why`): the person reads it before they hand the line over.' };
  return { ok: true, proposal: { app: to, line: redactSecrets(text), why: redactSecrets(reason).slice(0, MAX_WHY) } };
}

const fileOf = (id, home) => join(proposalsDir(home), `${id}.json`);

function writeJson(file, value) {
  writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2));
  renameSync(`${file}.tmp`, file);
}

/** Writes a checked proposal ({ app, line, why }) as pending: the proposal with its `id` and `at`. */
export function writeProposal(proposal, { home = familyDir(), now = Date.now() } = {}) {
  mkdirSync(proposalsDir(home), { recursive: true });
  const id = `${now.toString(36)}-${randomBytes(3).toString('hex')}`;
  const p = { id, app: proposal.app, line: proposal.line, why: proposal.why, at: now, status: 'pending' };
  writeJson(fileOf(id, home), p);
  return p;
}

/** Proposal `id` as it was written, or null (no such one, an id that isn't one, or it dropped off). */
export function readProposal(id, { home = familyDir() } = {}) {
  if (!ID.test(String(id ?? ''))) return null;
  try {
    const p = JSON.parse(readFileSync(fileOf(id, home), 'utf8'));
    return p && typeof p === 'object' && p.id === id ? p : null;
  } catch {
    return null;
  }
}

/** The proposals of the last `maxAge` ms, oldest first; `pending` only the ones still waiting. */
export function listProposals({ home = familyDir(), now = Date.now(), maxAge = MAX_AGE, pending = false } = {}) {
  let names = [];
  try {
    names = readdirSync(proposalsDir(home)).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    const p = readProposal(n.slice(0, -5), { home });
    if (!p || now - Number(p.at) > maxAge) continue;
    if (pending && p.status !== 'pending') continue;
    out.push(p);
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Marks proposal `id` `status` ('handed' or 'dismissed') at `now`: the proposal, or null when it's gone. */
export function decideProposal(id, status, { home = familyDir(), now = Date.now() } = {}) {
  const p = readProposal(id, { home });
  if (!p) return null;
  const next = { ...p, status, decidedAt: now };
  try {
    writeJson(fileOf(id, home), next);
  } catch {
    return null;
  }
  return next;
}

/** Removes the files of proposals older than `maxAge` (and any that can't be read): the host does it as it reads. */
export function pruneProposals({ home = familyDir(), now = Date.now(), maxAge = MAX_AGE } = {}) {
  let names = [];
  try {
    names = readdirSync(proposalsDir(home));
  } catch {
    return;
  }
  for (const n of names) {
    const file = join(proposalsDir(home), n);
    try {
      const p = n.endsWith('.json') ? readProposal(n.slice(0, -5), { home }) : null;
      const old = p ? now - Number(p.at) > maxAge : now - statSync(file).mtimeMs > maxAge;
      if (old) rmSync(file, { force: true });
    } catch {}
  }
}
