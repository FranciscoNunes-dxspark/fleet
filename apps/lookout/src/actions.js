// Every user-facing operation, written once: keys and slash commands call these with `ctx` (App's).
// Questions before anything that writes a file or changes trust live here (`ctx.confirm`).
import { basename, resolve } from 'node:path';
import { run } from '@fleet/kit/run.js';
import { contextIn, copiedNote, notMine, pathArg, shareLine, takeLine } from '@fleet/kit/family.js';
import { resolveFolder, samePath } from '@fleet/kit/folders.js';
import { describeEnvironments, setEnvironment } from '@fleet/kit/environments.js';
import { findingPlace } from '@fleet/kit/findings.js';
import { THEMES, applyTheme, isColour, setAccent, theme } from './theme.js';
import { configFile } from './config.js';
import { bodyText, capturedLine, filtered, mediaType } from './exchange.js';
import { maskBody, maskUrl } from './redact.js';
import { appendBlock, httpBlock, namesIn, requestContext } from './httpfile.js';
import { fromHar, toHar } from './har.js';
import { DEFAULT_MAX_BODY, DEFAULT_PORT, matchesHost } from './proxy.js';
import { httpsProxyLine } from './setup.js';
import { VERSION } from './app.js';

const firstLine = (s) => String(s ?? '').split('\n')[0];
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The default .http file requests go to, in the folder Lookout runs in. */
export const HTTP_FILE = 'lookout.http';

/** What the settings say the proxy should do. */
export const proxyOptions = (config) => ({
  intercept: config.intercept === true,
  passThrough: config.passThrough ?? [],
  maxBody: Math.round((Number(config.maxBodyMb) > 0 ? Number(config.maxBodyMb) : DEFAULT_MAX_BODY / 1024 / 1024) * 1024 * 1024),
});

/** /start [port]: listens on 127.0.0.1 (the setting's port, else 8888); a port given is kept as the setting. */
export async function start(ctx, arg = '') {
  const given = arg.trim() ? Number(arg.trim()) : null;
  if (given != null && !(Number.isInteger(given) && given > 0 && given < 65536)) return ctx.note('/start takes a port from 1 to 65535.', 'error') ?? false;
  const port = given ?? ctx.port ?? ctx.config.port ?? DEFAULT_PORT;
  if (ctx.listening) await stop(ctx, { quiet: true });
  const r = await ctx.task(
    `listen on ${port}`,
    async () => {
      const address = await ctx.provider.start({ port, ...proxyOptions(ctx.config), onExchange: ctx.onExchange });
      ctx.setListening(address);
      if (ctx.paused) ctx.provider.configure({ paused: true });
      return { stdout: `Listening on ${address.host}:${address.port}${ctx.config.intercept ? ', HTTPS intercepted' : ', HTTPS as tunnels (/intercept on reads it)'}\n${httpsProxyLine(address.port)}   (the Setup view, 4, has the rest)` };
    },
    { label: 'Starting' },
  );
  if (r.ok && given != null) ctx.setConfig((c) => ({ ...c, port: given }));
  return r.ok;
}

/** /stop: stops listening; what was captured stays. */
export async function stop(ctx, { quiet = false } = {}) {
  if (!ctx.listening) return quiet ? true : ctx.note('Lookout isn\'t listening: /start listens.');
  flushActivity(ctx);
  await ctx.provider.stop();
  ctx.setListening(null);
  if (!quiet) ctx.note('Stopped listening. What was captured stays; /start listens again.');
  return true;
}

/** space or /pause: passes traffic on without recording it, or records again. */
export function pause(ctx) {
  const next = !ctx.paused;
  ctx.setPaused(next);
  ctx.provider.configure({ paused: next });
  ctx.note(next ? 'Paused: traffic still passes, nothing is recorded (space records again).' : 'Recording again.');
  return true;
}

/** /port <n>: the port to listen on, kept; listening again on it when listening now. */
export async function port(ctx, arg = '') {
  if (!arg.trim()) return ctx.note(`Port: ${ctx.config.port ?? DEFAULT_PORT}${ctx.listening ? ` (listening on ${ctx.listening.port})` : ''}. /port <n> changes it.`);
  const n = Number(arg.trim());
  if (!(Number.isInteger(n) && n > 0 && n < 65536)) return ctx.note('A port is a number from 1 to 65535.', 'error') ?? false;
  ctx.setConfig((c) => ({ ...c, port: n }));
  return ctx.listening ? start(ctx, String(n)) : ctx.note(`Port: ${n}. /start listens on it.`, 'ok') ?? true;
}

/**
 * /intercept [on|off]: HTTPS read through Lookout's certificate authority, or passed through as
 * tunnels. The first time, it's asked before the CA is made; then the Setup view says how to trust it.
 */
export async function intercept(ctx, arg = '') {
  const want = arg.trim().toLowerCase();
  if (!want) return ctx.note(`HTTPS interception is ${ctx.config.intercept ? 'on' : 'off'}. /intercept on|off.`);
  if (!['on', 'off'].includes(want)) return ctx.note('/intercept on or /intercept off.', 'error') ?? false;
  if (want === 'off') {
    ctx.setConfig((c) => ({ ...c, intercept: false }));
    ctx.provider.configure({ intercept: false });
    ctx.note('HTTPS interception off: HTTPS passes through as tunnels, recorded by host name.', 'ok');
    return true;
  }
  const info = ctx.provider.caInfo();
  if (!info.exists) {
    const yes = await ctx.confirm({
      title: 'Make a certificate authority for Lookout?',
      detail: `To read HTTPS, Lookout answers clients with certificates it signs itself. The authority that signs them is made once and kept in ${info.paths.dir}, its key readable by you alone; it never leaves this machine. Clients see HTTPS only once you trust it: the Setup view says how, per system.`,
    });
    if (!yes) return false;
  }
  let made;
  try {
    made = ctx.provider.ensureCA();
  } catch (e) {
    return ctx.note(`Couldn't make the certificate authority: ${firstLine(e.message)}`, 'error') ?? false;
  }
  ctx.setConfig((c) => ({ ...c, intercept: true }));
  ctx.provider.configure({ intercept: true });
  ctx.note(`HTTPS interception on${made.made ? `: a certificate authority was made in ${made.paths.cert}` : ''}.\nTrust it once for each client (the Setup view, 4); a client that doesn't shows as refused.`, 'ok');
  ctx.setView('setup');
  return true;
}

/** /ca: the certificate authority, and how to trust it (the Setup view). */
export function ca(ctx) {
  ctx.setView('setup');
  const info = ctx.provider.caInfo();
  return ctx.note(info.exists ? `${info.paths.cert}\nSHA-256 ${info.fingerprint}` : 'No certificate authority yet: /intercept on makes one (it asks first).');
}

const passList = (ctx) => ctx.config.passThrough ?? [];

/** Whether a name is one the pass-through list can hold: a host, or *.host. */
const validPattern = (s) => /^(\*\.)?[a-z0-9_]([a-z0-9_.-]*[a-z0-9_])?$/i.test(s) || /^[0-9a-f:.]+$/i.test(s);

/** /pass [host]: a host (or *.example.com) passed through untouched, kept; alone, the list. */
export function pass(ctx, arg = '') {
  const host = arg.trim().toLowerCase();
  if (!host) return ctx.note(passList(ctx).length ? `Passed through untouched: ${passList(ctx).join(', ')}. /unpass <host> takes one off.` : 'Nothing is passed through: every host is intercepted while /intercept is on. /pass <host> or *.example.com.');
  if (!validPattern(host)) return ctx.note(`${host} isn't a host name (or *.example.com).`, 'error') ?? false;
  if (matchesHost(passList(ctx), host)) return ctx.note(`${host} is passed through already.`);
  const next = [...passList(ctx), host];
  ctx.setConfig((c) => ({ ...c, passThrough: next }));
  ctx.provider.configure({ passThrough: next });
  ctx.note(`${host} passes through untouched from its next connection: its traffic goes, unread.`, 'ok');
  return true;
}

/** /unpass <host|all>: back to being intercepted. */
export function unpass(ctx, arg = '') {
  const host = arg.trim().toLowerCase();
  if (!host) return pass(ctx, '');
  const next = host === 'all' ? [] : passList(ctx).filter((h) => h !== host);
  if (next.length === passList(ctx).length) return ctx.note(`${host} isn't on the pass-through list.`, 'error') ?? false;
  ctx.setConfig((c) => ({ ...c, passThrough: next }));
  ctx.provider.configure({ passThrough: next });
  ctx.note(host === 'all' ? 'Nothing is passed through now.' : `${host} is intercepted again (while /intercept is on).`, 'ok');
  return true;
}

/** p on a row: its host passed through, asked first (a refused handshake's way out). */
export async function passHost(ctx, ex) {
  if (!ex) return false;
  if (matchesHost(passList(ctx), ex.host)) return unpass(ctx, ex.host);
  const yes = await ctx.confirm({
    title: `Pass ${ex.host} through untouched?`,
    detail: `${ex.kind === 'refused' ? 'Its client refused Lookout\'s certificate. ' : ''}Its traffic still goes through Lookout, as a tunnel recorded by its host name alone. Kept in the settings; /unpass ${ex.host} takes it off.`,
  });
  return yes ? pass(ctx, ex.host) : false;
}

/** /filter [words…]: what the Requests view shows (host:, status:, method: and words); alone, everything. */
export function filter(ctx, text = '') {
  ctx.setFilter(text.trim());
  ctx.setView('requests');
  const n = filtered(ctx.exchanges(), text).length;
  return ctx.note(text.trim() ? `Showing ${n} of ${ctx.exchanges().length}: ${text.trim()} (/filter alone shows all)` : `Showing all ${ctx.exchanges().length}.`);
}

/**
 * The family's activity log hears how many requests went to which hosts since it was last told (no
 * path, header or body): on /stop, /clear, quitting, and every few minutes while traffic comes.
 */
export function flushActivity(ctx) {
  const line = capturedLine(ctx.takeUnlogged());
  if (line) ctx.logActivity(line[0].toUpperCase() + line.slice(1));
}

/** c or /clear: forgets what was captured (asked first). */
export async function clear(ctx) {
  const n = ctx.exchanges().length;
  if (!n) return ctx.note('Nothing to clear.');
  const yes = await ctx.confirm({ title: `Forget ${plural(n, 'captured exchange')}?`, detail: 'They are only in memory: /export writes them to a HAR file first, if you want them.' });
  if (!yes) return false;
  flushActivity(ctx);
  ctx.clearExchanges();
  ctx.note(`Forgot ${plural(n, 'exchange')}.`, 'ok');
  return true;
}

/** The .http file `arg` names (from the folder Lookout runs in), else the setting's, else lookout.http. */
const httpFileOf = (ctx, arg) => resolve(ctx.cwd(), pathArg(arg) || ctx.config.httpFile || HTTP_FILE);

/**
 * h or /hail [file]: the request written to a .http file (lookout.http unless named), credentials as
 * variables, and the file handed to Hail to open (/open), where it's ready to send again.
 */
export function hail(ctx, ex, arg = '') {
  if (!ex) return ctx.note('Nothing picked: move to a request in the Requests view.', 'error') ?? false;
  if (ex.kind !== 'http') return ctx.note(ex.kind === 'tunnel' ? 'A tunnel has no request Lookout could read: /intercept on reads HTTPS.' : 'A refused handshake has no request.', 'error') ?? false;
  const file = httpFileOf(ctx, arg);
  let text = '';
  try {
    if (ctx.provider.exists(file)) text = ctx.provider.readFile(file);
  } catch (e) {
    return ctx.note(`Couldn't read ${basename(file)}: ${firstLine(e.message)}`, 'error') ?? false;
  }
  const { block, name, variables } = httpBlock(ex, { taken: namesIn(text) });
  try {
    ctx.provider.writeFile(file, appendBlock(text, block));
  } catch (e) {
    return ctx.note(`Couldn't write ${basename(file)}: ${firstLine(e.message)}`, 'error') ?? false;
  }
  const line = shareLine('open', [file]);
  ctx.copy(line, 'a line for Hail');
  ctx.note([`Wrote ${name} to ${basename(file)}${variables.length ? `, with ${variables.map((v) => `{{${v}}}`).join(', ')} in place of credentials` : ''}`, copiedNote('hail', line)].join('\n'), 'ok');
  return true;
}

/** t: the request as a `request` context for Hail's /take (credentials as variables, as in the file). */
export function take(ctx, ex) {
  if (!ex || ex.kind !== 'http') return ctx.note('Move to a request first: tunnels and refused handshakes have none.', 'error') ?? false;
  const line = takeLine('request', requestContext(ex));
  ctx.copy(line, 'a line for Hail');
  ctx.note(copiedNote('hail', line));
  return true;
}

/** y: the URL, with its secrets masked (s in the detail view shows them). */
export function copyUrl(ctx, ex) {
  if (!ex) return false;
  const url = ex.kind === 'http' ? maskUrl(ex.url) : `${ex.host}:${ex.port}`;
  ctx.copy(url, url);
  return true;
}

/** ↵ or d/r in the detail view: a body as JSON or CSV in the data viewer, masked unless `secrets`. */
export function bodyData(ctx, ex, which = 'response', { secrets = false } = {}) {
  const part = which === 'request' ? ex?.request : ex?.response;
  const text = part ? bodyText(part) : null;
  if (!text) return ctx.note(`The ${which} has no text body.`, 'error') ?? false;
  ctx.showData({ title: `${which === 'request' ? 'Request' : 'Response'} body · ${ex.method} ${ex.host}${secrets ? '' : ' (secrets hidden)'}`, text: secrets ? text : maskBody(text, mediaType(part)) });
  return true;
}

/** /export [file.har] [secrets]: what's shown (the filter's), as HAR; credentials masked unless `secrets`, which asks. */
export async function exportHar(ctx, arg = '') {
  const words = arg.trim().split(/\s+/).filter(Boolean);
  const secrets = words.some((w) => /^(secrets|--secrets)$/i.test(w));
  const name = words.filter((w) => !/^(secrets|--secrets)$/i.test(w)).join(' ');
  const list = ctx.shown().filter((ex) => ex.kind === 'http');
  if (!list.length) return ctx.note('No requests to export (tunnels and refused handshakes have none).', 'error') ?? false;
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const file = resolve(ctx.cwd(), pathArg(name) || `lookout-${stamp}.har`);
  if (secrets) {
    const yes = await ctx.confirm({ title: `Write ${plural(list.length, 'request')} with their credentials?`, detail: 'Tokens, cookies and keys go into the file as they were: anyone who gets the file can use them. HAR files end up in tickets and chats.' });
    if (!yes) return false;
  }
  if (ctx.provider.exists(file)) {
    const yes = await ctx.confirm({ title: `Replace ${basename(file)}?` });
    if (!yes) return false;
  }
  try {
    ctx.provider.writeFile(file, `${JSON.stringify(toHar(list, { version: VERSION, secrets }), null, 2)}\n`);
  } catch (e) {
    return ctx.note(`Couldn't write ${basename(file)}: ${firstLine(e.message)}`, 'error') ?? false;
  }
  ctx.note(`${plural(list.length, 'request')} in ${file}${secrets ? ', credentials included' : ', credentials masked (/export <file> secrets keeps them)'}`, 'ok');
  return true;
}

/** /import <file.har>: a HAR file's requests added to the list (a browser's DevTools export, say). */
export function importHar(ctx, arg = '') {
  if (!arg.trim()) return ctx.note('/import <file.har>: a browser\'s or Lookout\'s HAR export.', 'error') ?? false;
  const file = resolve(ctx.cwd(), pathArg(arg));
  let list;
  try {
    list = fromHar(ctx.provider.readFile(file));
  } catch (e) {
    return ctx.note(`Couldn't read ${basename(file)}: ${firstLine(e.message)}`, 'error') ?? false;
  }
  ctx.addExchanges(list);
  ctx.setView('requests');
  ctx.note(`${plural(list.length, 'request')} from ${basename(file)}`, 'ok');
  return true;
}

/** /maxbody [MB]: the most of each body kept. */
export function maxBody(ctx, arg = '') {
  if (!arg.trim()) return ctx.note(`Each body is kept up to ${ctx.config.maxBodyMb ?? 1} MB (the rest still passes). /maxbody <MB> changes it.`);
  const mb = Number(arg.trim());
  if (!(mb > 0 && mb <= 512)) return ctx.note('/maxbody takes megabytes, from a fraction up to 512.', 'error') ?? false;
  const next = { ...ctx.config, maxBodyMb: mb };
  ctx.setConfig(next);
  ctx.provider.configure({ maxBody: proxyOptions(next).maxBody });
  ctx.note(`Each body is kept up to ${mb} MB.`, 'ok');
  return true;
}

/** ↵ on a finding: what it is, where, why it matters and the fix. */
export function showFinding(ctx, f) {
  ctx.showText(f.title, [`${f.severity.toUpperCase()}  ${f.title}`, `Where: ${findingPlace(f)}${f.count > 1 ? ` (seen ${f.count} times)` : ''}`, ...(f.excerpt ? [`Seen: ${f.excerpt}`] : []), '', f.why, '', `Fix: ${f.fix}`].join('\n'));
  return true;
}

/** /env [name]: the project's environment; a name switches every app of the family to it. */
export function env(ctx, name = '') {
  if (!name.trim()) return ctx.note(describeEnvironments(ctx.cwd()));
  const r = setEnvironment(ctx.cwd(), name, { by: 'lookout' });
  if (!r.ok) return ctx.note(r.error, 'error') ?? false;
  ctx.note(`Environment: ${r.env.name}${r.env.prod ? ' (production)' : ''}, for every app.`, 'ok');
  return true;
}

/** /take: Lookout takes no context of its own; it says whose a pasted one is. */
export function takeContext(ctx, text) {
  const context = contextIn(text);
  if (!context) return ctx.note('/take needs what a sibling copied: a family:v1:… line.', 'error') ?? false;
  return ctx.note(notMine('lookout', context), 'error') ?? false;
}

/** /move <folder>: where .http files and HAR exports go. */
export function move(ctx, folder = '') {
  const dir = ctx.cwd();
  if (!folder.trim()) return ctx.note(`Writing to ${dir}. /move <folder> writes .http files and HAR exports elsewhere.`);
  const target = resolveFolder(dir, folder);
  if (!target) return ctx.note(`There's no folder ${folder.trim()} here or beside ${basename(dir)}.`, 'error') ?? false;
  if (samePath(target, dir)) return ctx.note(`Lookout is in ${basename(target)} already.`);
  ctx.moveTo(target);
  return ctx.note(`Now in ${target}: .http files and HAR exports go here.`, 'ok') ?? true;
}

/** ! and /run: a shell command in the folder, its output in the activity line (/last has it all). */
export async function raw(ctx, command) {
  if (!command) return ctx.note('Type a command after !, e.g. !curl -x http://127.0.0.1:8888 http://example.com', 'error') ?? false;
  const r = await ctx.task(command, (signal) => run(command, { cwd: ctx.cwd(), signal }), { label: 'Running' });
  return r.ok;
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
  const info = ctx.provider.caInfo();
  ctx.showText(
    'Settings',
    [
      `Port             ${c.port ?? DEFAULT_PORT}${ctx.listening ? ` (listening on ${ctx.listening.host}:${ctx.listening.port})` : ' (not listening)'}       /port <n>, /start, /stop`,
      `Listen on start  ${on(c.autoStart)}       "autoStart" in the file`,
      `HTTPS            ${c.intercept ? 'intercepted' : 'tunnelled, by host name'}       /intercept on|off`,
      `Pass through     ${(c.passThrough ?? []).join(', ') || 'none'}       /pass <host>, /unpass <host>, p on a row (hosts whose clients pin their certificates)`,
      `Certificate      ${info.exists ? `${info.paths.cert}` : 'none yet (/intercept on makes one)'}       /ca`,
      `Body kept        up to ${c.maxBodyMb ?? 1} MB each       /maxbody <MB>`,
      `.http file       ${c.httpFile ?? HTTP_FILE}, in the folder Lookout is in       "httpFile" in the file; /hail <file> for one request`,
      `Theme            ${c.theme ?? 'auto'} (${theme.mode} here)       /theme dark|light|auto`,
      `Accent colour    ${c.accent ?? 'default'}       /accent #rrggbb`,
      `Mouse            ${on(c.mouse)}       /mouse on|off`,
      `Update checks    ${on(c.checkForUpdates)}       "checkForUpdates" in the file`,
      `Auto-update      ${on(c.autoUpdate)}       "autoUpdate" in the file`,
      `History          ${(c.history ?? []).length} lines`,
      '',
      `Kept in ${configFile()}`,
    ].join('\n'),
  );
  return true;
}
