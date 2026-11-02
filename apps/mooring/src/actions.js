// Every user-facing operation, written once: keys and slash commands call these with `ctx` (App.jsx's).
// Everything that changes or removes something asks first. Nothing here keeps a password or a
// passphrase: ssh signs in with a key or the agent, and says so when it can't.
import { run } from '@fleet/kit/run.js';
import { fit } from '@fleet/kit/text.js';
import { THEMES, applyTheme, isColour, setAccent, theme } from './theme.js';
import { configFile } from './config.js';
import { findHost, hostText, parseAdd, withHost, withoutHost } from './hosts.js';
import { joinRemote, resolveRemote, shellQuote } from './sftp.js';
import { IGNORE_FILE, checksumCandidates, checksumCommand, differs, ignoreList, isIgnored, loadBase, pairKey, parentsOf, parseChecksums, planCounts, planSync, saveBase, walkTree } from './sync.js';
import { removeTree } from './session.js';
import { sizeText } from './format.js';
import { DEFAULT_KEY_NAME, validKeyName } from './keygen.js';
import { askFirst } from './environment.js';
import { DISK_FULL, HEALTH_COMMAND, healthProblems, parseHealth, uptimeText } from './health.js';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ---------------------------------------------------------------------------------------------------
// Hosts

/** /connect [host]: opens the saved host (a list to pick from when none is named). */
export async function connect(ctx, name) {
  const hosts = ctx.config.hosts ?? [];
  if (!name?.trim()) {
    if (!hosts.length) return ctx.note('No saved hosts yet: /add <name> <user@host[:port]> [key=<file>] [folder=<remote folder>]') ?? false;
    return ctx.showPicker({
      title: 'Connect to',
      hint: '↵ connect',
      items: hosts.map((h) => ({ h, segments: hostSegments(h, ctx.conn.host) })),
      onPick: ({ h }) => {
        ctx.closeOverlay();
        connect(ctx, h.name);
      },
    });
  }
  const host = findHost(hosts, name.trim());
  if (!host) return ctx.note(`There's no saved host ${name.trim()}${hosts.length ? ` (${hosts.map((h) => h.name).join(', ')})` : ''}. /add saves one.`, 'error') ?? false;
  return ctx.connect(host);
}

export const hostSegments = (h, connected) => [
  { text: connected?.name === h.name ? '● ' : '  ', color: theme.accent, bold: true },
  { text: fit(h.name, 16), strong: true },
  { text: ` ${fit(hostText(h), 36)}`, color: theme.info },
  { text: ` ${h.password ? 'password' : (h.key ?? 'agent')}`, color: theme.dim },
  ...(h.folder ? [{ text: `  ${h.folder}`, color: theme.dim }] : []),
];

/** /add <name> <user@host[:port]> [key=<file>] [folder=<remote folder>]: saves a host (or changes the one of that name). */
export function addHost(ctx, rest) {
  const host = parseAdd(rest);
  if (host.error) return ctx.note(host.error, 'error') ?? false;
  const existed = (ctx.config.hosts ?? []).some((h) => h.name === host.name);
  ctx.setConfig({ ...ctx.config, hosts: withHost(ctx.config.hosts, host) });
  ctx.note(`${existed ? 'Changed' : 'Saved'} ${host.name}: ${hostText(host)}${host.key ? `, key ${host.key}` : ', your ssh agent'}\n/connect ${host.name} opens it.`, 'ok');
  return true;
}

/**
 * /keygen [name] [host]: makes an ed25519 key in ~/.ssh (asking first), copies its public half, and says where it goes:
 * the server's authorized_keys. With a saved host's name, that host is changed to sign in with the new key.
 */
export async function keygen(ctx, rest) {
  if (!ctx.keygen) return ctx.note("Making a key isn't available here.", 'error') ?? false;
  const [name = DEFAULT_KEY_NAME, hostName] = String(rest ?? '').trim().split(/\s+/).filter(Boolean);
  if (!validKeyName(name)) return ctx.note('A key name is letters, digits, . - and _ (no slash, and no dash first).', 'error') ?? false;
  const host = hostName ? findHost(ctx.config.hosts, hostName) : null;
  if (hostName && !host) return ctx.note(`There's no saved host ${hostName}.`, 'error') ?? false;
  const path = ctx.keygen.path(name);
  const yes = await ctx.confirm({
    title: `Make a new ssh key, ${path}?`,
    detail: `ed25519, with no passphrase (Mooring can't ask for one); anyone who can read the file can sign in as you${host ? `. ${host.name} will be saved to use it` : ''}.`,
    options: [
      { label: 'Make it', value: true },
      { label: 'Cancel', value: false },
    ],
  });
  if (!yes) return false;
  let made;
  const r = await ctx.task(
    `Making ${name}`,
    async () => {
      made = await ctx.keygen.generate(name);
      return { stdout: [made.path, made.fingerprint ?? '', made.publicKey].join('\n') };
    },
    { label: 'Making the key', activity: `made the ssh key ${name}` },
  );
  if (!r.ok) return ctx.note(r.error.message, 'error') ?? false;
  if (host) {
    const { password, ...others } = host;
    ctx.setConfig({ ...ctx.config, hosts: withHost(ctx.config.hosts, { ...others, key: made.path }) });
  }
  ctx.copy?.(made.publicKey, 'the public key');
  ctx.showText(
    `Made ${name}`,
    [
      `Private key: ${made.path} (keep it to yourself)`,
      `Fingerprint: ${made.fingerprint ?? ''}`,
      '',
      'Public key (copied; it is also in the file ending .pub):',
      made.publicKey,
      '',
      'Add that line to ~/.ssh/authorized_keys on the server, once, some way you can already sign in (a password, a console), e.g.:',
      '  ssh-copy-id -i ' + made.path + '.pub user@host',
      '',
      host ? `${host.name} now uses this key: /connect ${host.name}` : `Then: /add <name> user@host key=${made.path}`,
    ].join('\n'),
  );
  return true;
}

/** /forget <host>: takes a saved host out of the list (asks first). */
export async function forgetHost(ctx, name) {
  const host = findHost(ctx.config.hosts, String(name ?? '').trim());
  if (!host) return ctx.note(name ? `There's no saved host ${name}.` : 'Name a host: /forget <host>', 'error') ?? false;
  if (!(await ctx.confirm({ title: `Forget ${host.name} (${hostText(host)})?`, detail: 'Only the saved entry goes; nothing on the server, and no key file.' }))) return false;
  ctx.setConfig({ ...ctx.config, hosts: withoutHost(ctx.config.hosts, host.name) });
  ctx.note(`Forgot ${host.name}`);
  return true;
}

/** /disconnect: closes the connection (transfers still running are cancelled). */
export function disconnect(ctx) {
  if (!ctx.conn.host) return ctx.note('Not connected.') ?? false;
  ctx.disconnect();
  return true;
}

// ---------------------------------------------------------------------------------------------------
// Folders and files

/** The pane's folder as the user typed it: `..`, `~`, a relative or an absolute path. */
export async function cd(ctx, side, path) {
  const where = path?.trim();
  if (!where) return ctx.note(`/${side === 'local' ? 'lcd' : 'cd'} <folder>`, 'error') ?? false;
  if (side === 'remote' && !ctx.session) return ctx.note('Not connected: /connect <host>', 'error') ?? false;
  const pane = ctx.panes[side];
  let target;
  if (side === 'local') target = ctx.local.resolve(pane.dir, where);
  else if (where === '~') target = await ctx.session.home().catch(() => pane.dir);
  else target = resolveRemote(pane.dir, where.startsWith('~/') ? joinRemote(await ctx.session.home().catch(() => '/'), where.slice(2)) : where);
  return ctx.loadPane(side, target);
}

/** The parent of a pane's folder, with the cursor on the folder it came from. */
export function up(ctx, side) {
  const pane = ctx.panes[side];
  const parent = side === 'local' ? ctx.local.parent(pane.dir) : resolveRemote(pane.dir, '..');
  if (parent === pane.dir) return false;
  return ctx.loadPane(side, parent, { select: side === 'local' ? pane.dir.split(/[\\/]/).filter(Boolean).pop() : pane.dir.split('/').filter(Boolean).pop() });
}

/** Opens a folder entry (what ↵ does on one). */
export function enter(ctx, side, entry) {
  const pane = ctx.panes[side];
  const path = side === 'local' ? ctx.local.join(pane.dir, entry.name) : joinRemote(pane.dir, entry.name);
  return ctx.loadPane(side, path);
}

/** /mkdir <name> (or m): a new folder in the pane's folder. */
export async function mkdir(ctx, side, name) {
  const dir = ctx.panes[side].dir;
  const asked = name?.trim() ? name.trim() : await ctx.askText({ title: `New folder in ${dir}`, detail: 'its name', label: 'Name' });
  if (!asked) return false;
  if (/[\\/]/.test(asked)) return ctx.note('A folder name has no slash in it: go there first (/cd), then make it.', 'error') ?? false;
  const path = side === 'local' ? ctx.local.join(dir, asked) : joinRemote(dir, asked);
  const r = await ctx.task(`Creating ${asked}`, async () => (side === 'local' ? ctx.local.mkdir(path) : ctx.session.mkdir(path)), { label: 'Creating', activity: `created folder ${asked} on ${side === 'local' ? 'this machine' : (ctx.conn.host?.name ?? 'the server')}` });
  if (r.ok) await ctx.loadPane(side, dir, { select: asked });
  return r.ok;
}

/** r: renames the entry under the cursor. */
export async function rename(ctx, side, entry) {
  if (!entry) return false;
  const dir = ctx.panes[side].dir;
  const asked = await ctx.askText({ title: `Rename ${entry.name}`, detail: 'its new name', label: 'Name', value: entry.name });
  if (!asked || asked === entry.name) return false;
  if (/[\\/]/.test(asked)) return ctx.note('A name has no slash in it: this renames, it does not move.', 'error') ?? false;
  // Production is the server's: a rename there asks first.
  if (side === 'remote' && !(await askFirst(ctx, null, `Rename ${entry.name} to ${asked} on ${ctx.conn.host?.name ?? 'the server'}`))) return false;
  const [from, to] = side === 'local' ? [ctx.local.join(dir, entry.name), ctx.local.join(dir, asked)] : [joinRemote(dir, entry.name), joinRemote(dir, asked)];
  const r = await ctx.task(`Renaming ${entry.name} to ${asked}`, async () => (side === 'local' ? ctx.local.rename(from, to) : ctx.session.rename(from, to)), { label: 'Renaming', activity: `renamed ${entry.name} to ${asked} on ${side === 'local' ? 'this machine' : (ctx.conn.host?.name ?? 'the server')}` });
  if (r.ok) await ctx.loadPane(side, dir, { select: asked });
  return r.ok;
}

const isDir = (e) => e.kind === 'dir' || e.isDir;

/** d / x: deletes the entries (a folder with all that's in it), asking first, and saying which and how many. */
export async function remove(ctx, side, entries) {
  if (!entries.length) return false;
  const dir = ctx.panes[side].dir;
  const where = side === 'local' ? 'on this machine' : `on ${ctx.conn.host?.name ?? 'the server'}`;
  const folders = entries.filter(isDir).length;
  const title = entries.length === 1 ? `Delete ${entries[0].name} ${where}?` : `Delete ${plural(entries.length, 'item')} ${where}?`;
  const detail = [entries.length > 1 ? entries.slice(0, 3).map((e) => e.name).join(', ') + (entries.length > 3 ? '…' : '') : '', folders ? `${plural(folders, 'folder')} with everything in ${folders === 1 ? 'it' : 'them'}. ` : '', 'This can not be undone.'].filter(Boolean).join(' · ');
  if (!(await (side === 'remote' ? askFirst(ctx, { title, detail, danger: true }) : ctx.confirm({ title, detail, danger: true })))) return false;
  const r = await ctx.task(
    entries.length === 1 ? `Deleting ${entries[0].name}` : `Deleting ${plural(entries.length, 'item')}`,
    async (signal) => {
      for (const e of entries) {
        if (signal.aborted) throw Object.assign(new Error('Cancelled'), { cancelled: true });
        if (side === 'local') await ctx.local.remove(ctx.local.join(dir, e.name));
        else if (isDir(e) && e.kind === 'dir') await removeTree(ctx.session, joinRemote(dir, e.name), { signal });
        else await ctx.session.rm(joinRemote(dir, e.name));
      }
      return { stdout: `Deleted ${plural(entries.length, 'item')}`, stderr: '' };
    },
    { label: 'Deleting', activity: `deleted ${entries.length === 1 ? entries[0].name : plural(entries.length, 'item')} ${where}` },
  );
  await ctx.loadPane(side, dir);
  return r.ok;
}

/** i: what is known of an entry. */
export function info(ctx, side, entry) {
  if (!entry) return false;
  const dir = ctx.panes[side].dir;
  const path = side === 'local' ? ctx.local.join(dir, entry.name) : joinRemote(dir, entry.name);
  ctx.showText(entry.name, [`path      ${path}`, `kind      ${entry.kind}${entry.isDir ? ' (to a folder)' : ''}`, ...(entry.link ? [`points to ${entry.link}`] : []), ...(entry.kind === 'file' ? [`size      ${sizeText(entry.size)} (${entry.size} bytes)`] : []), `mode      ${entry.mode || '—'}`, `modified  ${entry.modified ? new Date(entry.modified).toISOString().slice(0, 19).replace('T', ' ') : '—'}`].join('\n'));
  return true;
}

/**
 * c: queues the entries from `side` to the other pane's folder: uploads from this machine, downloads
 * from the server. An existing file of that name asks first (replace, replace all, skip).
 */
export async function copyOver(ctx, side, entries) {
  if (!ctx.session) return ctx.note('Not connected: /connect <host>', 'error') ?? false;
  const picks = entries.filter((e) => e.kind === 'file' || isDir(e));
  if (!picks.length) return ctx.note(entries.length ? 'Only files and folders are copied (not special files).' : 'Nothing to copy.', 'error') ?? false;
  if (side === 'local' && !(await askFirst(ctx, null, `Upload ${picks.length === 1 ? picks[0].name : plural(picks.length, 'item')} to ${ctx.conn.host.name}`))) return false;
  const other = side === 'local' ? 'remote' : 'local';
  const from = ctx.panes[side];
  const to = ctx.panes[other];
  let all = false;
  let queued = 0;
  for (const e of picks) {
    const there = to.entries.find((x) => x.name === e.name);
    if (there && (isDir(there) !== isDir(e))) {
      ctx.note(`${e.name} is a ${isDir(there) ? 'folder' : 'file'} on the other side: skipped.`, 'error');
      continue;
    }
    if (there && !isDir(e) && !all) {
      const answer = await ctx.confirm({
        title: `${e.name} is in ${to.dir} already. Replace it?`,
        detail: `${sizeText(e.size)} here, ${sizeText(there.size)} there`,
        danger: true,
        options: [
          { label: 'Replace', value: 'yes' },
          { label: 'Replace this and every other', value: 'all' },
          { label: 'Skip it', value: 'skip' },
          { label: 'Stop copying', value: null },
        ],
      });
      if (answer == null) break;
      if (answer === 'skip') continue;
      if (answer === 'all') all = true;
    }
    const [src, dst] =
      side === 'local' ? [ctx.local.join(from.dir, e.name), joinRemote(to.dir, e.name)] : [joinRemote(from.dir, e.name), ctx.local.join(to.dir, e.name)];
    ctx.queue.add({ kind: side === 'local' ? 'upload' : 'download', name: e.name, from: src, to: dst, recursive: isDir(e), size: isDir(e) ? null : e.size });
    queued++;
  }
  if (queued) ctx.note(`Queued ${plural(queued, 'transfer')} ${side === 'local' ? 'to' : 'from'} ${ctx.conn.host.name}: 2 shows them.`, 'ok');
  return queued > 0;
}

/** /put <name> and /get <name>: queues one named entry of the pane's folder. */
export async function transferNamed(ctx, side, name) {
  const pane = ctx.panes[side];
  const found = pane.entries.filter((e) => e.name === name?.trim());
  if (!found.length) return ctx.note(name?.trim() ? `${name.trim()} isn't in ${pane.dir}.` : `/${side === 'local' ? 'put' : 'get'} <name>`, 'error') ?? false;
  return copyOver(ctx, side, found);
}

// ---------------------------------------------------------------------------------------------------
// Syncing a folder

const SYNC_WORDS = { up: 'up (the server made like this machine)', down: 'down (this machine made like the server)', both: 'both ways' };
const ARROW = { upload: '↑', download: '↓', 'delete-local': '✗', 'delete-remote': '✗', conflict: '!', extra: '·' };
const VERB = { upload: 'upload', download: 'download', 'delete-local': 'delete here', 'delete-remote': 'delete there', conflict: 'conflict', extra: 'leave' };

/** The panes' two folders as one pair to sync, with the sides as walkTree lists them. */
function syncPair(ctx) {
  const localRoot = ctx.panes.local.dir;
  const remoteRoot = ctx.panes.remote.dir;
  return {
    localRoot,
    remoteRoot,
    key: pairKey(ctx.conn.host.name, localRoot, remoteRoot),
    local: { list: (d) => ctx.local.list(d), join: (d, n) => ctx.local.join(d, n) },
    remote: { list: (d) => ctx.session.list(d), join: joinRemote },
  };
}

/** The ignore list: the defaults and the local folder's .mooringignore. */
async function ignoreOf(ctx, localRoot) {
  return ignoreList((await ctx.local.readText?.(ctx.local.join(localRoot, IGNORE_FILE)).catch(() => null)) ?? '');
}

/** The paths a checksum shows to be the same on both sides: sha256sum on the server in one ssh call, and here. */
async function sameByChecksum(ctx, pair, local, remote, signal) {
  const rels = checksumCandidates(local, remote);
  if (!rels.length) return new Set();
  const r = await ctx.session.exec(checksumCommand(pair.remoteRoot, rels, shellQuote), { signal });
  if (r.code !== 0 && !r.stdout) throw new Error(`sha256sum on the server: ${String(r.stderr).split('\n')[0] || `exit ${r.code}`}`);
  const there = parseChecksums(r.stdout);
  const same = new Set();
  for (const rel of rels) if (there.has(rel) && there.get(rel) === (await ctx.local.hash(ctx.local.join(pair.localRoot, ...rel.split('/'))))) same.add(rel);
  return same;
}

/** After a sync's transfers: what is the same on both sides now is the pair's new base. */
async function keepBase(pair, patterns) {
  const [l, r] = await Promise.all([walkTree(pair.local, pair.localRoot, patterns), walkTree(pair.remote, pair.remoteRoot, patterns)]);
  const files = new Map();
  for (const [rel, f] of l.files) if (r.files.has(rel) && !differs(f, r.files.get(rel))) files.set(rel, f);
  saveBase(pair.key, files);
}

/** Queues a plan's transfers (the folders they go into made first) and resolves the ids queued. */
async function queuePlan(ctx, pair, plan, local) {
  const ups = plan.filter((p) => p.action === 'upload');
  const downs = plan.filter((p) => p.action === 'download');
  // A folder that is there already says so; that's no reason to stop.
  for (const d of parentsOf(ups.map((p) => p.rel))) await ctx.session.mkdir(joinRemote(pair.remoteRoot, d)).catch(() => {});
  for (const d of parentsOf(downs.map((p) => p.rel))) await ctx.local.mkdir(ctx.local.join(pair.localRoot, ...d.split('/'))).catch(() => {});
  const ids = [];
  for (const p of [...ups, ...downs]) {
    const [here, there] = [ctx.local.join(pair.localRoot, ...p.rel.split('/')), joinRemote(pair.remoteRoot, p.rel)];
    ids.push(ctx.queue.add(p.action === 'upload' ? { kind: 'upload', name: p.rel, from: here, to: there, size: p.size, modified: local?.get(p.rel)?.modified } : { kind: 'download', name: p.rel, from: there, to: here, size: p.size }));
  }
  return ids;
}

/**
 * /sync [down|up|both] [--checksum] [--delete]: compares the left pane's folder with the right's (size
 * and time; with --checksum, sha256 for the files that differ only in time), shows the plan, asks, and
 * sends what changed through the queue. A file only on one side is deleted only with --delete;
 * conflicts (changed on both sides since the last sync) are shown and left for /sync up or down.
 */
export async function sync(ctx, rest) {
  if (!ctx.session) return ctx.note('Not connected: /connect <host>', 'error') ?? false;
  const words = String(rest ?? '').trim().split(/\s+/).filter(Boolean);
  const direction = words.find((w) => ['up', 'down', 'both'].includes(w)) ?? 'both';
  const checksum = words.includes('--checksum');
  const deletes = words.includes('--delete');
  const unknown = words.filter((w) => !['up', 'down', 'both', '--checksum', '--delete'].includes(w));
  if (unknown.length) return ctx.note(`/sync [down|up|both] [--checksum] [--delete]: ${unknown.join(' ')} isn't one of them.`, 'error') ?? false;
  const pair = syncPair(ctx);
  const patterns = await ignoreOf(ctx, pair.localRoot);
  const base = direction === 'both' ? loadBase(pair.key) : null;
  const r = await ctx.task(
    `Comparing ${pair.localRoot} with ${ctx.conn.host.name}:${pair.remoteRoot}`,
    async (signal) => {
      const [l, rm] = await Promise.all([walkTree(pair.local, pair.localRoot, patterns, { signal }), walkTree(pair.remote, pair.remoteRoot, patterns, { signal })]);
      const same = checksum ? await sameByChecksum(ctx, pair, l.files, rm.files, signal) : new Set();
      const plan = planSync({ local: l.files, remote: rm.files, base, direction, deletes, same });
      const n = planCounts(plan);
      return { plan, local: l.files, remote: rm.files, same, stdout: `${l.files.size} files here, ${rm.files.size} there: ${n.upload} to upload, ${n.download} to download, ${n['delete-local'] + n['delete-remote']} to delete, ${n.conflict} in conflict` };
    },
    { label: 'Comparing' },
  );
  if (!r.ok) return false;
  const { plan, local, remote, same } = r.result;
  const n = planCounts(plan);
  const work = n.upload + n.download + n['delete-local'] + n['delete-remote'];
  if (!work) {
    // Already the same: that is the base the next sync compares with.
    saveBase(pair.key, new Map([...local].filter(([rel, f]) => remote.has(rel) && (same.has(rel) || !differs(f, remote.get(rel))))));
    return ctx.note(n.conflict ? `Nothing to sync but ${plural(n.conflict, 'conflict')}: /sync up or /sync down settles ${n.conflict === 1 ? 'it' : 'them'}.` : `In sync: ${pair.localRoot} and ${ctx.conn.host.name}:${pair.remoteRoot}${n.extra ? ` (${plural(n.extra, 'file')} only on one side: --delete removes ${n.extra === 1 ? 'it' : 'them'})` : ''}.`, n.conflict ? 'error' : 'ok') ?? !n.conflict;
  }
  ctx.showText(`Sync ${SYNC_WORDS[direction]}`, plan.map((p) => `${VERB[p.action]}  ${p.why}  ${p.rel}`).join('\n'), {
    lines: [
      [{ text: `${pair.localRoot}  ⇄  ${ctx.conn.host.name}:${pair.remoteRoot}`, color: theme.dim }],
      [],
      ...plan.map((p) => [
        { text: `${ARROW[p.action]} `, color: p.action === 'conflict' || p.action.startsWith('delete') ? theme.del : p.action === 'extra' ? theme.dim : theme.accent, bold: true },
        { text: fit(VERB[p.action], 13), color: p.action === 'conflict' ? theme.del : undefined },
        { text: fit(p.why, 28), color: theme.dim },
        { text: p.rel },
        ...(p.size != null ? [{ text: `  ${sizeText(p.size)}`, color: theme.dim }] : []),
      ]),
    ],
  });
  const what = [n.upload && plural(n.upload, 'upload'), n.download && plural(n.download, 'download'), n['delete-local'] && `${n['delete-local']} deleted here`, n['delete-remote'] && `${n['delete-remote']} deleted on ${ctx.conn.host.name}`].filter(Boolean).join(', ');
  // Anything going to the server (an upload, a delete there) asks as production does.
  const ask = n.upload + n['delete-remote'] ? askFirst : (c, req) => c.confirm(req);
  const yes = await ask(ctx, {
    title: `Sync ${direction === 'both' ? 'both ways' : direction}: ${what}?`,
    detail: [n.conflict ? `${plural(n.conflict, 'conflict')} left alone.` : '', n.extra ? `${plural(n.extra, 'file')} only on one side kept (--delete removes them).` : ''].filter(Boolean).join(' ') || undefined,
    danger: n['delete-local'] + n['delete-remote'] > 0,
    options: [
      { label: 'Sync', value: true },
      { label: 'Cancel', value: false },
    ],
  });
  ctx.closeOverlay();
  if (!yes) return false;
  const gone = plan.filter((p) => p.action.startsWith('delete'));
  if (gone.length) {
    const d = await ctx.task(
      `Deleting ${plural(gone.length, 'file')} the sync removes`,
      async () => {
        for (const p of gone) {
          if (p.action === 'delete-local') await ctx.local.remove(ctx.local.join(pair.localRoot, ...p.rel.split('/')));
          else await ctx.session.rm(joinRemote(pair.remoteRoot, p.rel));
        }
        return { stdout: gone.map((p) => p.rel).join('\n') };
      },
      { label: 'Deleting', activity: `deleted ${plural(gone.length, 'file')} in a sync with ${ctx.conn.host.name}` },
    );
    if (!d.ok) return false;
  }
  const ids = await queuePlan(ctx, pair, plan, local);
  ctx.note(ids.length ? `Queued ${plural(ids.length, 'transfer')} for the sync with ${ctx.conn.host.name}: 2 shows them.` : `Synced with ${ctx.conn.host.name}.`, 'ok');
  // Once the transfers are through, what is the same on both sides is what the next sync compares with.
  ctx.queue.idle().then(() => keepBase(pair, patterns)).catch(() => {});
  if (gone.length) await Promise.all([ctx.loadPane('local', pair.localRoot), ctx.loadPane('remote', pair.remoteRoot)]);
  return true;
}

/**
 * The files `rels` (changed under a watched folder) uploaded as they are now: each one still a file
 * and not ignored is queued, the folders it goes into made first. Deletions aren't carried over.
 */
export async function uploadChanged(ctx, watching, rels) {
  if (!ctx.session) return 0;
  const files = [];
  for (const rel of [...new Set(rels)].sort()) {
    if (isIgnored(watching.patterns, rel)) continue;
    const parts = rel.split('/');
    const dir = ctx.local.join(watching.localRoot, ...parts.slice(0, -1));
    const entry = (await ctx.local.list(dir).catch(() => [])).find((e) => e.name === parts.at(-1));
    if (entry?.kind === 'file') files.push({ rel, size: entry.size, modified: entry.modified, action: 'upload' });
  }
  if (!files.length) return 0;
  await queuePlan(ctx, watching, files, new Map(files.map((f) => [f.rel, f])));
  return files.length;
}

/** /watch [off]: keeps uploading what changes in the left pane's folder to the right pane's, until /watch off. */
export async function watch(ctx, arg) {
  const word = String(arg ?? '').trim();
  if (word === 'off') {
    if (!ctx.watching) return ctx.note('Nothing is being watched.') ?? true;
    const was = ctx.watching;
    ctx.stopWatch();
    return ctx.note(`Stopped watching ${was.localRoot}.`) ?? true;
  }
  if (word) return ctx.note('/watch, or /watch off', 'error') ?? false;
  if (!ctx.session) return ctx.note('Not connected: /connect <host>', 'error') ?? false;
  if (!ctx.local.watch) return ctx.note("Watching a folder isn't available here.", 'error') ?? false;
  const { localRoot, remoteRoot } = syncPair(ctx);
  const yes = await askFirst(ctx, { title: `Upload what changes in ${localRoot} to ${ctx.conn.host.name}:${remoteRoot}, as it changes?`, detail: 'Until /watch off. Deletions are not carried over; the ignore list applies.' });
  if (!yes) return false;
  ctx.startWatch({ localRoot, remoteRoot, host: ctx.conn.host.name, patterns: await ignoreOf(ctx, localRoot) });
  ctx.note(`Watching ${localRoot}: changes go up to ${ctx.conn.host.name}:${remoteRoot}. /watch off stops it.`, 'ok');
  return true;
}

// ---------------------------------------------------------------------------------------------------
// The server's health

const mb = (n) => (n >= 1024 ? `${(n / 1024).toFixed(1)} GB` : `${n} MB`);
const meter = (percent, width = 20) => {
  const on = Math.round((Math.min(100, Math.max(0, percent)) / 100) * width);
  return '█'.repeat(on) + '░'.repeat(width - on);
};

/** The health panel's rows: coloured segments, what is wrong in red. */
export function healthRows(h, host) {
  const rows = [];
  const head = (text) => rows.push([], [{ text, color: theme.accent, bold: true }]);
  const problems = healthProblems(h);
  rows.push(problems.length ? [{ text: `${host}: ${problems.join(', ')}`, color: theme.del, bold: true }] : [{ text: `${host} looks well`, color: theme.accent, bold: true }]);
  const load = h.load ? `load ${h.load.map((n) => n.toFixed(2)).join(' ')}` : 'load unknown';
  const busy = h.load && h.cpus && h.load[0] > h.cpus;
  rows.push([{ text: `up ${uptimeText(h.uptime) || '?'}`, color: theme.dim }, { text: '  ·  ', color: theme.dim }, { text: load, color: busy ? theme.warn : undefined }, { text: h.cpus ? ` on ${plural(h.cpus, 'CPU')}` : '', color: theme.dim }]);
  head('Disks');
  if (!h.disks.length) rows.push([{ text: 'df said nothing', color: theme.dim }]);
  for (const d of h.disks) {
    const full = d.percent > DISK_FULL;
    rows.push([{ text: fit(d.mount, 18) }, { text: meter(d.percent), color: full ? theme.del : theme.info }, { text: ` ${String(d.percent).padStart(3)}%`, color: full ? theme.del : undefined, bold: full }, { text: `  ${sizeText(d.availKb * 1024)} free of ${sizeText(d.sizeKb * 1024)}`, color: theme.dim }, { text: `  ${d.fs}`, color: theme.dim }]);
  }
  // Failed units next to the disks: what is wrong comes before what is merely busy.
  head('Failed units');
  if (h.failed == null) rows.push([{ text: 'no systemd here', color: theme.dim }]);
  else if (!h.failed.length) rows.push([{ text: 'none', color: theme.dim }]);
  for (const u of h.failed ?? []) rows.push([{ text: `✗ ${u.unit}`, color: theme.del, bold: true }, { text: u.description ? `  ${u.description}` : '', color: theme.dim }]);
  head('Memory');
  if (!h.memory) rows.push([{ text: 'not known', color: theme.dim }]);
  else {
    const m = h.memory;
    const pct = m.totalMb ? Math.round((m.usedMb / m.totalMb) * 100) : 0;
    rows.push([{ text: fit('memory', 18) }, { text: meter(pct), color: pct > 90 ? theme.warn : theme.info }, { text: ` ${String(pct).padStart(3)}%` }, { text: `  ${mb(m.usedMb)} used of ${mb(m.totalMb)}, ${mb(m.availableMb)} available`, color: theme.dim }]);
    if (m.swapTotalMb) rows.push([{ text: fit('swap', 18) }, { text: `${mb(m.swapUsedMb)} used of ${mb(m.swapTotalMb)}`, color: theme.dim }]);
  }
  for (const [title, list, key] of [
    ['Busiest by CPU', h.topCpu, 'cpu'],
    ['Busiest by memory', h.topMem, 'mem'],
  ]) {
    head(title);
    if (!list.length) rows.push([{ text: 'ps said nothing', color: theme.dim }]);
    for (const p of list) rows.push([{ text: `${String(p[key].toFixed(1)).padStart(5)}%  `, color: theme.info }, { text: fit(p.command, 30) }, { text: `  pid ${p.pid}  ${key === 'cpu' ? `${p.mem.toFixed(1)}% memory` : `${p.cpu.toFixed(1)}% CPU`}`, color: theme.dim }]);
  }
  rows.push([], [{ text: 'r reads it again · esc closes', color: theme.dim }]);
  return rows;
}

/** /health or alt+h: one ssh command's worth of the server's state, in a panel; r there reads it again. */
export async function health(ctx) {
  if (!ctx.session) return ctx.note('Not connected: /connect <host>', 'error') ?? false;
  const host = ctx.conn.host.name;
  const r = await ctx.task(
    `Reading ${host}'s health`,
    async (signal) => {
      const out = await ctx.session.exec(HEALTH_COMMAND, { signal });
      const h = parseHealth(out.stdout);
      const problems = healthProblems(h);
      return { health: h, stdout: problems.length ? problems.join(', ') : 'Nothing wrong' };
    },
    { label: 'Reading the health' },
  );
  if (!r.ok) return false;
  const h = r.result.health;
  ctx.setHealth({ host, at: Date.now(), problems: healthProblems(h) });
  ctx.showText(`Health · ${host}`, '', { kind: 'health', lines: healthRows(h, host), onKey: (input) => input === 'r' && (health(ctx), true) });
  return true;
}

// ---------------------------------------------------------------------------------------------------
// Settings

/** ! and /run: a shell command on this machine, its output in the activity line (/last has it all). */
export async function raw(ctx, command) {
  if (!command) return ctx.note('Type a command after !, e.g. !ssh-add -l', 'error') ?? false;
  const r = await ctx.task(command, (signal) => run(command, { signal, cwd: ctx.panes.local.dir }), { label: 'Running' });
  return r.ok;
}

/** /hidden [on|off]: whether files starting with a dot are listed. */
export function setHidden(ctx, value) {
  const now = ctx.config.showHidden !== false;
  if (!['on', 'off'].includes(value)) return ctx.setHidden(!now);
  return ctx.setHidden(value === 'on');
}

/** /theme: dark, light or auto; with no argument says which. */
export function setTheme(ctx, value) {
  if (!value) return ctx.note(`Theme: ${ctx.config.theme ?? 'auto'} (${theme.mode} here). /theme ${THEMES.join('|')} changes it.`);
  if (!THEMES.includes(value)) return ctx.note(`Theme is one of ${THEMES.join(', ')}.`, 'error') ?? false;
  const next = { ...ctx.config, theme: value };
  ctx.setConfig(next);
  applyTheme(next);
  ctx.note(`Theme: ${value}`);
  return true;
}

/** /accent: a #rrggbb colour, or `default`. */
export function accent(ctx, value) {
  if (!value) return ctx.note(`Accent: ${ctx.config.accent ?? 'default'} (${theme.accent}). /accent #rrggbb changes it.`);
  if (value !== 'default' && !isColour(value)) return ctx.note('An accent is #rrggbb, or "default".', 'error') ?? false;
  const next = { ...ctx.config };
  if (value === 'default') delete next.accent;
  else next.accent = value;
  ctx.setConfig(next);
  setAccent(next.accent);
  ctx.note(`Accent: ${value}`);
  return true;
}

/** /mouse: on or off. */
export function mouse(ctx, value) {
  if (!['on', 'off'].includes(value)) return ctx.note(`Mouse is ${ctx.config.mouse === false ? 'off' : 'on'}. /mouse on|off changes it.`);
  ctx.setConfig({ ...ctx.config, mouse: value === 'on' });
  ctx.note(`Mouse: ${value}${value === 'off' ? ' (the terminal selects text again)' : ''}`);
  return true;
}

/** /settings: what's set, and where it's kept. */
export function settings(ctx) {
  const c = ctx.config;
  const on = (v) => (v === false ? 'off' : 'on');
  ctx.showText(
    'Settings',
    [
      `Saved hosts      ${(c.hosts ?? []).length}       /add, /forget`,
      `Hidden files     ${on(c.showHidden)}       /hidden on|off`,
      `Transfers        ${c.transfers ?? 2} at a time       "transfers" in the file`,
      `Theme            ${c.theme ?? 'auto'} (${theme.mode} here)       /theme dark|light|auto`,
      `Accent colour    ${c.accent ?? 'default'}       /accent #rrggbb`,
      `Mouse            ${on(c.mouse)}       /mouse on|off`,
      `Update checks    ${on(c.checkForUpdates)}       "checkForUpdates" in the file`,
      `Auto-update      ${on(c.autoUpdate)}       "autoUpdate" in the file`,
      `History          ${(c.history ?? []).length} lines`,
      '',
      `Kept in ${configFile()} (where each host is and which key signs in: never a password or a passphrase)`,
    ].join('\n'),
  );
  return true;
}
