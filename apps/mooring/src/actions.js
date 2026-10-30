// Every user-facing operation, written once: keys and slash commands call these with `ctx` (App.jsx's).
// Everything that changes or removes something asks first. Nothing here keeps a password or a
// passphrase: ssh signs in with a key or the agent, and says so when it can't.
import { run } from '@fleet/kit/run.js';
import { fit } from '@fleet/kit/text.js';
import { THEMES, applyTheme, isColour, setAccent, theme } from './theme.js';
import { configFile } from './config.js';
import { findHost, hostText, parseAdd, withHost, withoutHost } from './hosts.js';
import { joinRemote, resolveRemote } from './sftp.js';
import { removeTree } from './session.js';
import { sizeText } from './format.js';

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
  { text: ` ${h.key ?? 'agent'}`, color: theme.dim },
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
  const r = await ctx.task(`Creating ${asked}`, async () => (side === 'local' ? ctx.local.mkdir(path) : ctx.session.mkdir(path)), { label: 'Creating' });
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
  const [from, to] = side === 'local' ? [ctx.local.join(dir, entry.name), ctx.local.join(dir, asked)] : [joinRemote(dir, entry.name), joinRemote(dir, asked)];
  const r = await ctx.task(`Renaming ${entry.name} to ${asked}`, async () => (side === 'local' ? ctx.local.rename(from, to) : ctx.session.rename(from, to)), { label: 'Renaming' });
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
  if (!(await ctx.confirm({ title, detail, danger: true }))) return false;
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
