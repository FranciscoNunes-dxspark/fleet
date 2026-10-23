// Every user-facing operation, written once: keys and slash commands both call these with `ctx`
// (built in ui/App.jsx). Questions before anything destructive belong here too (ctx.confirm).
import { writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { label } from './azure/arm.js';
import { EXPORTS } from './export.js';
import { findLogin, ruleCovering, ruleName, trawlCommand } from './trawl.js';
import { mapLimited, sqlByLabel } from './tree.js';
import { clip } from './claude-cli.js';
import { configFile } from './config.js';
import { cellText, compareQueries, compareWindows, isProduction, latestExceptionQuery, looksSecret, operationQuery, records, settingsDiff, sqlDependenciesQuery, windowsAround } from './insights.js';
import { deploymentsBefore, exceptionContext, framesInCheckout, framesOf, gitLogCommand, incidentFile, incidentMarkdown, parseGitLog, requestContext, requestOf, sqlTarget, writeupPrompt } from './incident.js';
import { repoRoot, shareLine, takeLine } from './family.js';
import { copiedNote } from './kin.js';
import { openUrl } from './open.js';
import { run } from './run.js';
import { nextTheme, settingRows, settingSegments } from './settings.js';
import { BULLET, applyTheme, defaultAccent, isColour, setAccent, theme } from './theme.js';
import { fit, relTime } from './text.js';

const firstLine = (s) => String(s ?? '').split('\n')[0];

const YES_NO = (yes) => [
  { label: yes, value: true },
  { label: 'No', value: false },
];

/** ! and /run: a shell command, with the spinner, esc to cancel and its output in the activity lines. */
export function raw(ctx, command) {
  const text = command.trim();
  if (!text) return ctx.note('Type a command after !, e.g. !node --version', 'error');
  return ctx.task(text, (signal) => run(text, { signal }), { label: 'Running' });
}

// Changing anything in Azure goes through here: a plain yes or no, or, for production (and for every
// swap, which changes what production serves), typing the app's name, as the portal asks for deletes.
async function confirmChange(ctx, target, { title, detail, strict = false, yes }) {
  if (strict || isProduction(target)) {
    const typed = await ctx.askText({ title: `${title} Type ${target.name} to go ahead.`, detail: detail ?? `${label(target)} looks like production.` });
    if (typed == null) return false;
    if (typed.trim() !== target.name) {
      ctx.note(`That isn't ${target.name}, so nothing was changed.`, 'error');
      return false;
    }
    return true;
  }
  return ctx.confirm({ title, detail, danger: true, options: YES_NO(yes) });
}

/** An app or slot by label ("contoso-web/staging"), or the one under the cursor in Resources. */
export function targetNamed(ctx, name) {
  const n = name?.trim();
  if (!n) return ctx.selectedTarget();
  return ctx.targets()[n] ?? Object.values(ctx.targets()).find((t) => label(t).toLowerCase() === n.toLowerCase()) ?? null;
}

/** What a resource is, in words. */
export const typeLabel = (t) => ({ container: 'container app', storage: 'storage account', sqlserver: 'SQL server', sqldb: 'SQL database' })[t.type] ?? (t.kind === 'function' ? 'function app' : 'web app');

const need = (ctx, target) => target ?? (ctx.note('Pick an app or a slot in Resources first, or name one.', 'error'), null);

/** R and /restart. */
export async function restart(ctx, which) {
  const target = need(ctx, typeof which === 'object' ? which : targetNamed(ctx, which));
  if (!target) return;
  if (!(await confirmChange(ctx, target, { title: `Restart ${label(target)}?`, detail: 'Requests in flight are dropped while it comes back up.', yes: 'Yes, restart it' }))) return;
  await ctx.task(`Restart ${label(target)}`, async (signal) => {
    await ctx.provider.restart(target, { signal });
    return { stdout: `${label(target)} is restarting` };
  }, { label: 'Restarting', refresh: true });
}

/** S and /stop, /start: stops a running app or slot, starts a stopped one. */
export async function toggleRunning(ctx, which, want) {
  const target = need(ctx, typeof which === 'object' ? which : targetNamed(ctx, which));
  if (!target) return;
  const stop = want ? want === 'stop' : target.state === 'Running';
  if (stop && !(await confirmChange(ctx, target, { title: `Stop ${label(target)}?`, detail: 'It serves nothing until it is started again.', yes: 'Yes, stop it' }))) return;
  await ctx.task(`${stop ? 'Stop' : 'Start'} ${label(target)}`, async (signal) => {
    await ctx.provider[stop ? 'stop' : 'start'](target, { signal });
    return { stdout: `${label(target)} ${stop ? 'stopped' : 'started'}` };
  }, { label: stop ? 'Stopping' : 'Starting', refresh: true });
}

/** W and /swap: a slot into production (on an app, one of its slots, picked from a list). */
export async function swap(ctx, which) {
  const target = need(ctx, typeof which === 'object' ? which : targetNamed(ctx, which));
  if (!target) return;
  if (!target.slot) {
    const app = ctx.data.apps.find((a) => a.id === target.id);
    const slots = ctx.data.slots[target.id] ?? [];
    if (!slots.length) return ctx.note(`${target.name} has no slots to swap in.`, 'error');
    if (slots.length === 1) return swap(ctx, slots[0]);
    return ctx.showPicker({ title: `Swap which slot of ${app.name} into production?`, items: slots.map((s) => ({ slot: s, segments: [{ text: s.slot, strong: true }, { text: `  ${s.host ?? ''}`, color: theme.dim }] })), onPick: (it) => (ctx.closeOverlay(), swap(ctx, it.slot)) });
  }
  const [now, next] = await Promise.all([ctx.settingsOf({ ...target, id: target.id.replace(/\/slots\/[^/]+$/, ''), slot: null }), ctx.settingsOf(target)]).catch(() => [null, null]);
  const changes = now && next ? settingsDiff(now, next).length : null;
  const ok = await confirmChange(ctx, target, {
    title: `Swap ${label(target)} into production?`,
    detail: `${target.name} then serves what ${target.slot} has${changes != null ? `; ${changes} setting${changes === 1 ? '' : 's'} differ (a in Resources compares them)` : ''}, and ${target.slot} gets what production had.`,
    strict: true,
  });
  if (!ok) return;
  await ctx.task(`Swap ${label(target)} into production`, async (signal) => {
    await ctx.provider.swap(target, { signal });
    return { stdout: `Swapping ${label(target)} into production: Azure carries on with it for a minute or two` };
  }, { label: 'Swapping', refresh: true });
}

const hide = (name, value) => (looksSecret(name, value) ? '••••••' : value);

/** a and /settings-of: an app's or slot's settings, values that look secret hidden until v shows them. */
export async function showSettings(ctx, which, { replace = false, index, shown = [] } = {}) {
  const target = need(ctx, typeof which === 'object' ? which : targetNamed(ctx, which));
  if (!target) return;
  const settings = await ctx.settingsOf(target).catch((e) => (ctx.note(e.message, 'error'), null));
  if (!settings) return;
  const names = Object.keys(settings).sort((a, b) => a.localeCompare(b));
  const nameW = Math.min(40, Math.max(10, ...names.map((n) => n.length)));
  const again = (opts = {}) => showSettings(ctx, target, { replace: true, index: ctx.overlay()?.index, shown, ...opts });
  ctx.showPicker(
    {
      title: `Settings of ${label(target)}`,
      hint: 'v show · e edit · n new · x remove · d compare · y copy',
      empty: 'No settings. n adds one.',
      index,
      items: names.map((n) => ({
        name: n,
        segments: [
          { text: `${n.padEnd(nameW)}  `, strong: true },
          { text: shown.includes(n) || shown.includes('*') ? settings[n] : hide(n, settings[n]), color: looksSecret(n, settings[n]) ? theme.warn : undefined },
        ],
      })),
      keys: {
        v: (it) => again({ shown: shown.includes(it.name) ? shown.filter((x) => x !== it.name) : [...shown, it.name] }),
        V: () => again({ shown: shown.includes('*') ? [] : ['*'] }),
        y: (it) => ctx.copy(settings[it.name], `the value of ${it.name}`),
        e: async (it) => {
          const value = await ctx.askText({ title: `${it.name} on ${label(target)}`, detail: 'The new value; esc leaves it as it is.', value: settings[it.name] });
          if (value != null && value !== settings[it.name]) await saveSettings(ctx, target, settings, { ...settings, [it.name]: value }, again);
        },
        x: async (it) => {
          const { [it.name]: _, ...rest } = settings;
          await saveSettings(ctx, target, settings, rest, again);
        },
        d: () => compareSettings(ctx, target),
      },
      actions: {
        n: async () => {
          const name = await ctx.askText({ title: `A new setting on ${label(target)}: its name`, detail: 'Letters, digits, _ and __ for nesting (Logging__LogLevel__Default).' });
          if (!name?.trim()) return;
          const value = await ctx.askText({ title: `${name.trim()} on ${label(target)}: its value` });
          if (value != null) await saveSettings(ctx, target, settings, { ...settings, [name.trim()]: value }, again);
        },
        d: () => compareSettings(ctx, target),
      },
    },
    { replace },
  );
}

/** Saves `next` over `before` once you've seen what changes; Azure restarts the app to take them. */
async function saveSettings(ctx, target, before, next, redraw) {
  const diff = settingsDiff(before, next);
  if (!diff.length) return;
  const said = diff.map((d) => (d.change === 'only-a' ? `remove ${d.name}` : d.change === 'only-b' ? `add ${d.name}` : `change ${d.name}`)).join(', ');
  const ok = await confirmChange(ctx, target, { title: `Save ${label(target)}'s settings: ${said}?`, detail: 'Azure restarts the app to take them.', yes: 'Yes, save them' });
  if (!ok) return;
  const done = await ctx.task(`Save ${label(target)}'s settings: ${said}`, async (signal) => {
    await ctx.provider.saveSettings(target, next, { signal });
    ctx.forgetSettings(target);
    return { stdout: 'Saved; the app restarts to take them' };
  }, { label: 'Saving' });
  if (done.ok) redraw();
}

/** d in the settings, and /compare: how this slot's settings differ from another slot's of the same app. */
export async function compareSettings(ctx, which, other) {
  const target = need(ctx, typeof which === 'object' ? which : targetNamed(ctx, which));
  if (!target) return;
  const appId = target.id.replace(/\/slots\/[^/]+$/, '');
  const app = ctx.data.apps.find((a) => a.id === appId);
  const siblings = [app, ...(ctx.data.slots[appId] ?? [])].filter((t) => t && t.id !== target.id);
  if (!siblings.length) return ctx.note(`${label(target)} has no other slot to compare with.`, 'error');
  const versus = other ?? (siblings.length === 1 ? siblings[0] : null);
  if (!versus) {
    return ctx.showPicker({ title: `Compare ${label(target)} with`, items: siblings.map((t) => ({ t, segments: [{ text: label(t), strong: true }] })), onPick: (it) => compareSettings(ctx, target, it.t) });
  }
  const [a, b] = await Promise.all([ctx.settingsOf(target), ctx.settingsOf(versus)]);
  const diff = settingsDiff(a, b);
  const lines = diff.length
    ? diff.flatMap((d) => [
        [{ text: d.name, bold: true }],
        d.change !== 'only-b' ? [{ text: `  - ${label(target)}: `, color: theme.del }, { text: hide(d.name, d.a) }] : [{ text: `  - not on ${label(target)}`, color: theme.del }],
        d.change !== 'only-a' ? [{ text: `  + ${label(versus)}: `, color: theme.add }, { text: hide(d.name, d.b) }] : [{ text: `  + not on ${label(versus)}`, color: theme.add }],
      ])
    : [[{ text: 'They have the same settings.', color: theme.dim }]];
  ctx.showText(`${label(target)} → ${label(versus)}: ${diff.length} setting${diff.length === 1 ? '' : 's'} differ`, diff.map((d) => d.name).join('\n'), { lines });
}

const DEPLOY_COLOUR = { get succeeded() { return theme.add; }, get failed() { return theme.del; } };

/** D and /deployments: an app's or slot's deployments, newest first; ↵ shows one's log. */
export function deployments(ctx, which) {
  const target = need(ctx, typeof which === 'object' ? which : targetNamed(ctx, which));
  if (!target) return;
  if (target.type) return ctx.note(`Only web and function apps have deployments here; ${target.name} is a ${typeLabel(target)}.`, 'error');
  ctx.showPicker({
    title: `Deployments of ${label(target)}`,
    hint: '↵ its log · y copy its id',
    empty: 'No deployments: it was never deployed through App Service (zip, Git, Actions…).',
    load: async () =>
      (await ctx.provider.deployments(target)).map((d) => ({
        d,
        segments: [
          { text: `${BULLET} `, color: DEPLOY_COLOUR[d.status] ?? theme.warn },
          { text: fit(d.status, 10), color: DEPLOY_COLOUR[d.status] ?? theme.warn },
          { text: fit(d.start ? `${relTime(Date.parse(d.start))} ago` : '', 9), color: theme.dim },
          { text: fit(d.author || '—', 16), strong: true },
          { text: fit(d.deployer, 16), color: theme.info },
          { text: d.active ? 'active  ' : '', color: theme.accent, bold: true },
          { text: d.message.split('\n')[0] },
        ],
      })),
    onPick: (it) => deploymentLog(ctx, target, it.d),
    keys: { y: (it) => ctx.copy(it.d.name, 'its id') },
  });
}

/** ↵ on a deployment: its log, in the viewer. */
export async function deploymentLog(ctx, target, d) {
  const title = `${label(target)}: deployment ${d.name}, ${d.status}`;
  const token = {};
  ctx.showText(title, '', { loading: true, token });
  const still = () => ctx.overlay()?.token === token;
  try {
    const log = await ctx.provider.deploymentLog(d);
    if (!still()) return;
    const head = [`${d.author || 'Someone'}${d.deployer ? ` through ${d.deployer}` : ''}, ${d.start ? cellText(d.start, 'datetime') : 'when unknown'}${d.end ? ` to ${cellText(d.end, 'datetime').slice(11)}` : ''}`, d.message, ''];
    const text = [...head, ...log.map((l) => `${l.at ? cellText(l.at, 'datetime').slice(11) : ''}  ${l.message}`)].join('\n');
    const lines = [
      [{ text: head[0], bold: true }],
      ...d.message.split('\n').map((m) => [{ text: m, color: theme.dim }]),
      [],
      ...(log.length ? log : [{ message: 'Its log is empty.' }]).map((l) => [
        { text: l.at ? `${cellText(l.at, 'datetime').slice(11)}  ` : '', color: theme.dim },
        { text: l.message, color: /fail|error|err!/i.test(l.message) ? theme.del : undefined },
      ]),
    ];
    ctx.showText(title, text, { lines, token });
  } catch (e) {
    if (still()) ctx.closeOverlay();
    ctx.note(e.message, 'error');
  }
}

/** R on a container app: restarts its latest revision, which restarts its replicas. */
export async function restartContainer(ctx, app) {
  if (!app.latestRevision) return ctx.note(`${app.name} has no revision to restart.`, 'error');
  const ok = await confirmChange(ctx, app, { title: `Restart ${app.name} (revision ${app.latestRevision})?`, detail: 'Its replicas start again; work in flight is dropped.', yes: 'Yes, restart it' });
  if (!ok) return;
  await ctx.task(`Restart ${app.name}`, async (signal) => {
    await ctx.provider.restartRevision(app, { signal });
    return { stdout: `${app.name}'s revision ${app.latestRevision} is restarting` };
  }, { label: 'Restarting', refresh: true });
}

/** l on a container app: its console log, from the Log Analytics workspace its environment writes to. */
export async function containerLogs(ctx, app) {
  let workspace;
  try {
    workspace = await ctx.provider.containerAppWorkspace(app);
  } catch (e) {
    return ctx.note(e.message, 'error');
  }
  ctx.setComponent(workspace);
  return runQuery(ctx, `ContainerAppConsoleLogs_CL | where ContainerAppName_s == '${app.name.replace(/'/g, "\\'")}' | project TimeGenerated, RevisionName_s, Log_s | order by TimeGenerated desc | take 100`);
}

/** A SQL server by name, or a database as "server/database"; else the one under the cursor in Resources. */
export function sqlNamed(ctx, name) {
  const n = name?.trim();
  const sel = ctx.selectedResource();
  if (!n) return sel?.type === 'sqlserver' || sel?.type === 'sqldb' ? sel : null;
  const all = sqlByLabel(ctx.data?.sqlServers);
  return all[n] ?? Object.entries(all).find(([k]) => k.toLowerCase() === n.toLowerCase())?.[1] ?? null;
}

const serverOf = (ctx, t) => (t.type === 'sqldb' ? (ctx.data?.sqlServers ?? []).find((s) => s.id === t.serverId) : t);

/**
 * Before connecting to `server` from here: whether its firewall lets this machine's public address
 * in, and if not, offers to add a rule for it (a change, so it asks as every change does). Resolves
 * 'covered', 'added', 'declined' or 'unknown' (the address or the rules couldn't be read).
 */
async function letMeIn(ctx, server, { always = false } = {}) {
  let ip;
  let rules;
  try {
    [ip, rules] = await Promise.all([ctx.provider.publicIp(), ctx.firewallOf(server)]);
  } catch (e) {
    ctx.note(`Couldn't check ${server.name}'s firewall: ${firstLine(e.message)}`, 'error');
    return 'unknown';
  }
  const rule = ruleCovering(ip, rules);
  if (rule) {
    if (always) ctx.note(`${server.name}'s firewall already lets ${ip} in (rule ${rule.name}).`);
    return 'covered';
  }
  const name = ruleName(ip);
  const ok = await confirmChange(ctx, server, {
    title: `Let ${ip} through ${server.name}'s firewall?`,
    detail: `No rule lets this machine in${rules.some((r) => r.start === '0.0.0.0' && r.end === '0.0.0.0') ? ' ("Allow Azure services" is for Azure, not you)' : ''}: this adds ${name}, for ${ip} alone.`,
    yes: 'Yes, add it',
  });
  if (!ok) return 'declined';
  const done = await ctx.task(`Add ${name} to ${server.name}'s firewall`, async (signal) => {
    await ctx.provider.addFirewallRule(server, { name, start: ip, end: ip }, { signal });
    ctx.forgetFirewall(server);
    return { stdout: `${server.name} lets ${ip} in (rule ${name}); it can take a few minutes to apply` };
  }, { label: 'Adding the rule' });
  return done.ok ? 'added' : 'unknown';
}

/** F and /firewall: lets this machine's public address through a SQL server's firewall. */
export async function firewall(ctx, which) {
  const t = typeof which === 'object' && which ? which : sqlNamed(ctx, which);
  if (!t) return ctx.note(which?.trim() ? `There's no SQL server called ${which.trim()}.` : 'Pick a SQL server (or one of its databases) in Resources first, or name one.', 'error');
  const server = serverOf(ctx, t);
  if (!server) return ctx.note(`Couldn't find ${t.server}'s server.`, 'error');
  return letMeIn(ctx, server, { always: true });
}

/** Where an app's SQL logins might be: every app's and slot's connection strings and settings. */
async function sqlSources(ctx, signal) {
  const targets = Object.values(ctx.targets());
  const lists = await mapLimited(targets, 6, async (target) => {
    const [strings, settings] = await Promise.all([ctx.provider.connectionStrings(target, { signal }).catch(() => ({})), ctx.settingsOf(target).catch(() => ({}))]);
    return [...Object.entries(strings), ...Object.entries(settings)].map(([setting, value]) => ({ target, setting, value: String(value ?? '') }));
  });
  return lists.flat();
}

/**
 * T and /trawl: a slash command for Trawl's prompt that opens the database (or server), copied to
 * the clipboard. It names the SQL login an app already uses for it, so Trawl reads the password from
 * that app through az (Sonar never copies or shows it); without one, Trawl signs in with Entra. The
 * firewall is checked first.
 */
export async function openInTrawl(ctx, which) {
  const t = typeof which === 'object' && which ? which : sqlNamed(ctx, which);
  if (!t) return ctx.note(which?.trim() ? `There's no SQL server or database called ${which.trim()}.` : 'Pick a SQL server or database in Resources first, or name one (server/database).', 'error');
  const server = serverOf(ctx, t);
  if (!server) return ctx.note(`Couldn't find ${t.server}'s server.`, 'error');
  const database = t.type === 'sqldb' ? t : null;
  const what = database ? label(database) : server.name;
  const access = await letMeIn(ctx, server);
  if (access === 'declined') ctx.note(`Trawl won't reach ${server.name} from here until its firewall lets this machine in (F adds it).`);
  let login = null;
  const found = await ctx.task(`Look for the login the apps use for ${what}`, async (signal) => {
    login = findLogin(await sqlSources(ctx, signal), server, database?.name);
    if (!login) return { stdout: `No app's connection string has a login for ${what}: Trawl signs in with Entra (az)` };
    if (login.entra) return { stdout: `${label(login.target)} signs in to ${what} with Entra (${login.setting}), and so will Trawl (az)` };
    return { stdout: `The login ${login.user}, from ${label(login.target)}'s ${login.setting}: Trawl reads its password from there through az` };
  }, { label: 'Looking through the apps' });
  if (!found.ok) return found;
  const line = trawlCommand({ server, database, login, subscription: ctx.data.subscription.id, prod: isProduction(server) });
  copyFor(ctx, 'trawl', line);
  return true;
}

/** A line for a sibling's prompt to the clipboard, and the log saying where to paste it. */
export function copyFor(ctx, app, line) {
  ctx.copy(line, `a line for ${app[0].toUpperCase()}${app.slice(1)}`);
  ctx.note(copiedNote(app, line), 'ok');
}

/** o: the app or slot in the Azure portal. b: its site. */
export async function openInPortal(ctx, target) {
  if (!need(ctx, target)) return;
  await openUrl(ctx.provider.portalUrl(target)).catch((e) => ctx.note(`Couldn't open the browser: ${e.message}`, 'error'));
}
export async function browse(ctx, target) {
  if (!need(ctx, target)) return;
  if (!target.host) return ctx.note(`${label(target)} has no address.`, 'error');
  await openUrl(`https://${target.host}`).catch((e) => ctx.note(`Couldn't open the browser: ${e.message}`, 'error'));
}

/** /sub: another subscription, named or picked. */
export function chooseSubscription(ctx, name) {
  const subs = ctx.data?.subscriptions ?? [];
  const n = name?.trim().toLowerCase();
  if (n) {
    const sub = subs.find((s) => s.name.toLowerCase() === n || s.id === n) ?? subs.find((s) => s.name.toLowerCase().includes(n));
    if (!sub) return ctx.note(`No subscription called ${name.trim()}.`, 'error');
    return ctx.openSubscription(sub.id);
  }
  ctx.showPicker({
    title: 'Subscription',
    index: Math.max(0, subs.findIndex((s) => s.id === ctx.data?.subscription.id)),
    items: subs.map((s) => ({ s, segments: [{ text: s.id === ctx.data?.subscription.id ? '● ' : '  ', color: theme.accent }, { text: s.name, strong: true }, { text: `  ${s.id}`, color: theme.dim }] })),
    onPick: (it) => (ctx.closeOverlay(), ctx.openSubscription(it.s.id)),
  });
}

/** c and /insights: which Application Insights Logs and Problems ask (by default, the selected app's). */
export function chooseComponent(ctx, name) {
  const list = ctx.data?.components ?? [];
  if (!list.length) return ctx.note('This subscription has no Application Insights to query.', 'error');
  const n = name?.trim().toLowerCase();
  if (n) {
    const c = list.find((x) => x.name.toLowerCase() === n);
    if (!c) return ctx.note(`No Application Insights called ${name.trim()}.`, 'error');
    return ctx.setComponent(c);
  }
  ctx.showPicker({
    title: 'Application Insights to query',
    items: [{ c: null, segments: [{ text: "The selected app's own", strong: true }] }, ...list.map((c) => ({ c, segments: [{ text: c.name, strong: true }, { text: `  ${c.resourceGroup}`, color: theme.dim }] }))],
    onPick: (it) => (ctx.closeOverlay(), ctx.setComponent(it.c)),
  });
}

/** /kql and ↵ in Logs: runs a query against the component in scope, over the time span. */
export async function runQuery(ctx, kql) {
  const q = kql.trim();
  if (!q) return ctx.note('Type a query, e.g. /kql requests | take 10', 'error');
  const scope = await ctx.scope();
  if (!scope.component) return ctx.note(scope.why, 'error');
  ctx.setView('logs');
  ctx.setQuery(q);
  const span = ctx.timespan();
  let result;
  const done = await ctx.task(`${scope.component.name} · ${span.label}: ${q}`, async (signal) => {
    result = await ctx.provider.query(scope.component, q, { timespan: span.iso, signal });
    return { stdout: `${result.rows.length} row${result.rows.length === 1 ? '' : 's'}` };
  }, { label: 'Querying' });
  if (done.ok) ctx.setResult({ query: q, component: scope.component, span, ...result });
  if (done.ok) ctx.setConfig((c) => ({ ...c, queries: [q, ...(c.queries ?? []).filter((x) => x !== q)].slice(0, 50) }));
}

/** s in Logs: the query under a name of yours, kept in the config for /queries. */
export async function saveQuery(ctx, kql) {
  const q = kql?.trim();
  if (!q) return ctx.note('Write a query first (e), then s saves it.', 'error');
  const saved = ctx.config.savedQueries ?? {};
  const already = Object.keys(saved).find((n) => saved[n] === q);
  const name = (await ctx.askText({ title: 'Save the query as', detail: q, value: already ?? '' }))?.trim();
  if (!name) return;
  ctx.setConfig((c) => ({ ...c, savedQueries: { ...(c.savedQueries ?? {}), [name]: q } }));
  ctx.note(`${name in saved ? 'Replaced' : 'Saved'} the query "${name}": /queries runs it again.`, 'ok');
}

/** /queries: your saved queries, ↵ runs one, x forgets it; with a name, runs that one. */
export function savedQueries(ctx, name, { replace = false, index } = {}) {
  const saved = ctx.config.savedQueries ?? {};
  const names = Object.keys(saved).sort((x, y) => x.localeCompare(y));
  const n = name?.trim();
  if (n) {
    const hit = names.find((x) => x === n) ?? names.find((x) => x.toLowerCase() === n.toLowerCase());
    if (!hit) return ctx.note(`No saved query called ${n}${names.length ? ` (there's ${names.join(', ')})` : ': s in Logs saves one'}.`, 'error');
    return runQuery(ctx, saved[hit]);
  }
  if (!names.length && !replace) return ctx.note('No saved queries yet: s in Logs saves the one in the box.');
  const nameW = Math.min(30, Math.max(8, ...names.map((x) => x.length)));
  ctx.showPicker(
    {
      title: 'Saved queries',
      hint: '↵ run it · x forget it · y copy it',
      empty: 'No saved queries left. s in Logs saves one.',
      index,
      items: names.map((x) => ({ name: x, segments: [{ text: `${x.padEnd(nameW)}  `, strong: true }, { text: saved[x], color: theme.dim }] })),
      onPick: (it) => {
        ctx.closeOverlay();
        runQuery(ctx, saved[it.name]);
      },
      keys: {
        x: (it) => {
          ctx.setConfig((c) => {
            const { [it.name]: _, ...rest } = c.savedQueries ?? {};
            return { ...c, savedQueries: rest };
          });
          ctx.note(`Forgot the query "${it.name}".`);
          savedQueries(ctx, null, { replace: true, index: Math.max(0, (ctx.overlay()?.index ?? 1) - 1) });
        },
        y: (it) => ctx.copy(saved[it.name], 'the query'),
      },
    },
    { replace },
  );
}

/** /export <file>: the grid in Logs to a .csv, .json or .md file (relative to the folder Sonar started in). */
export async function exportResult(ctx, path) {
  const result = ctx.result();
  if (!result) return ctx.note('Run a query in Logs first: there is nothing to export.', 'error');
  const p = String(path ?? '').trim().replace(/^"(.*)"$/, '$1');
  if (!p) return ctx.prefill('/export ');
  const full = resolve(p);
  const format = EXPORTS[extname(full).toLowerCase()];
  if (!format) return ctx.note('Export to a .csv, .json or .md file.', 'error');
  try {
    await writeFile(full, format(result), 'utf8');
    ctx.note(`Wrote ${result.rows.length} row${result.rows.length === 1 ? '' : 's'} to ${full}`, 'ok');
  } catch (e) {
    ctx.note(`Couldn't write ${full}: ${e.message}`, 'error');
  }
}

/** A problem's latest occurrence: every row of that operation, in order (the end-to-end transaction). */
async function occurrence(ctx, component, problem) {
  return records(await ctx.provider.query(component, operationQuery(problem.operation), { timespan: ctx.timespan().iso }));
}

const occurrenceSummary = (problem) => `${problem.count} times, ${problem.users} user${problem.users === 1 ? '' : 's'}, in ${problem.role} · operation ${problem.operation}`;

/** ↵ on a problem: its latest occurrence, everything in that operation, in order. */
export async function showOperation(ctx, problem) {
  const scope = await ctx.scope();
  if (!scope.component) return ctx.note(scope.why, 'error');
  // Closed while it loads: the answer doesn't open it again.
  const token = {};
  ctx.showText(`${problem.type}: the latest occurrence`, '', { loading: true, token });
  const still = () => ctx.overlay()?.token === token;
  try {
    const rows = await occurrence(ctx, scope.component, problem);
    if (!still()) return;
    const colour = { request: theme.info, dependency: theme.dim, exception: theme.del, trace: undefined };
    const lines = [
      [{ text: problem.message ?? '', bold: true }],
      [{ text: occurrenceSummary(problem), color: theme.dim }],
      [],
      ...rows.map((r) => [
        { text: `${cellText(r.timestamp, 'datetime').slice(11)}  `, color: theme.dim },
        { text: `${String(r.itemType).padEnd(11)}`, color: colour[r.itemType] },
        { text: `${r.name ?? ''}  `, bold: r.itemType === 'exception' },
        { text: `${r.detail ?? ''}`, color: r.success === false ? theme.del : theme.dim },
        { text: r.duration != null ? `  ${Math.round(r.duration)} ms` : '', color: theme.dim },
      ]),
    ];
    ctx.showText(`${problem.type}: the latest occurrence`, occurrenceText(problem, rows), { lines, token });
  } catch (e) {
    if (still()) ctx.closeOverlay();
    ctx.note(e.message, 'error');
  }
}

/** The occurrence as plain text: what y copies, and what w sends Claude. */
export function occurrenceText(problem, rows) {
  return [
    `${problem.type}: ${problem.message ?? ''}`,
    occurrenceSummary(problem),
    '',
    ...rows.map((r) => [cellText(r.timestamp, 'datetime'), String(r.itemType).padEnd(11), r.name ?? '', r.detail ?? '', r.success === false ? '(failed)' : '', r.duration != null ? `${Math.round(r.duration)} ms` : ''].filter(Boolean).join('  ')),
  ].join('\n');
}

/** The question for w and /why: what the problem is; its latest occurrence goes on stdin. */
export function whyPrompt(problem) {
  return [
    `"${problem.type}" is an exception in the Azure app "${problem.role}", seen ${problem.count} times lately (Application Insights problem "${problem.problemId}").`,
    "Its latest occurrence, end to end (the request, its dependencies, the exception and the traces, in order), is on stdin.",
    "Say in a few sentences what most likely went wrong and what to do about it. If the current folder holds the app's source, read the code involved to be specific. Plain text, no headings.",
  ].join(' ');
}

/** A problem by its id or type (or part of either), among those Problems shows; else the one under the cursor there. */
export function problemNamed(ctx, name) {
  const n = name?.trim().toLowerCase();
  if (!n) return ctx.selectedProblem();
  const list = ctx.problems();
  return list.find((p) => p.problemId.toLowerCase() === n) ?? list.find((p) => p.problemId.toLowerCase().includes(n) || p.type.toLowerCase().includes(n)) ?? null;
}

/** w on a problem and /why: Claude reads its latest occurrence (and the code, when Sonar runs in the app's checkout) and says why. */
export async function why(ctx, which) {
  const problem = typeof which === 'object' && which ? which : problemNamed(ctx, which);
  if (!problem) return ctx.note(which?.trim() ? `No problem like ${which.trim()} in Problems.` : 'Pick a problem in Problems first (3), or name one.', 'error');
  const scope = await ctx.scope();
  if (!scope.component) return ctx.note(scope.why, 'error');
  const r = await ctx.task(
    `Asking Claude about ${problem.type}`,
    async (signal) => {
      const rows = await occurrence(ctx, scope.component, problem);
      const input = clip(occurrenceText(problem, rows), 60_000);
      return { stdout: await ctx.askClaude(whyPrompt(problem), { input, cwd: ctx.cwd(), signal, tools: ['Read', 'Grep', 'Glob'] }) };
    },
    { label: 'Claude is reading it' },
  );
  if (r.ok) ctx.showText(`Why ${problem.type}`, r.out);
  return r;
}

/** The web app (main slot) a problem's role name is, for its deployments. */
const appOfRole = (ctx, role) => (ctx.data?.apps ?? []).find((a) => a.name === role) ?? null;

/** Lines of the files in the checkout (git ls-files), or [] when it can't be read. */
async function checkoutFiles(root) {
  const { stdout } = await run('git ls-files', { cwd: root });
  return stdout.split(/\r?\n/).filter(Boolean);
}

/**
 * Everything about a problem for the incident view: its latest exception (and so its stack), its latest
 * occurrence, the SQL that failed in its operations, the app's deployments before it was first seen, and
 * when Sonar runs in a checkout, the commits that touched the files in its stack before then.
 */
export async function gatherIncident(ctx, component, problem) {
  const opts = { timespan: ctx.timespan().iso };
  const ask = (q) => ctx.provider.query(component, q, opts).then(records);
  const target = appOfRole(ctx, problem.role);
  const [latest, rows, sql, deploys] = await Promise.all([
    ask(latestExceptionQuery(problem.problemId)).then((r) => r[0] ?? null),
    ask(operationQuery(problem.operation)),
    ask(sqlDependenciesQuery(problem.problemId)).catch(() => []),
    target ? ctx.provider.deployments(target).then((list) => deploymentsBefore(list, problem.first), (e) => ({ error: firstLine(e.message) })) : Promise.resolve({ within: [], latest: null, error: `no app called ${problem.role} in this subscription` }),
  ]);
  const frames = framesOf(latest?.details);
  const repo = repoRoot(ctx.cwd());
  let files = [];
  let commits = [];
  if (repo) {
    try {
      files = framesInCheckout(frames, await checkoutFiles(repo));
      if (files.length) commits = parseGitLog((await run(gitLogCommand(files.map((f) => f.path), problem.first), { cwd: repo })).stdout);
    } catch (e) {
      commits = { error: firstLine(e.message) };
    }
  }
  return { problem, spark: ctx.problemSpark(problem.problemId), span: ctx.timespan(), latest, rows, sql, deploys, frames, request: requestOf(rows), repo, files, commits };
}

const DOT = (colour) => ({ text: `${BULLET} `, color: colour });

/** The incident as the viewer draws it. */
function incidentLines(inc) {
  const p = inc.problem;
  const dim = (text) => ({ text, color: theme.dim });
  const head = (text) => [[], [{ text, bold: true, color: theme.accent }]];
  const time = (iso) => (iso ? cellText(iso, 'datetime') : '—');
  const lines = [
    [{ text: p.type, bold: true }],
    [{ text: p.message ?? '', color: theme.del }],
    [],
    [dim('app       '), { text: p.role ?? '—', color: theme.info }],
    [dim('first     '), { text: time(p.first) }, dim(`  (${relTime(Date.parse(p.first))} ago)`)],
    [dim('last      '), { text: time(p.last) }, dim(`  (${relTime(Date.parse(p.last))} ago)`)],
    [dim('count     '), { text: `${p.count}`, bold: true, color: theme.del }, dim(` in the last ${inc.span.label} · ${p.users} user${p.users === 1 ? '' : 's'}  `), { text: inc.spark ?? '', color: theme.warn }],
    ...head('Deployments in the 24 h before first seen'),
  ];
  if (inc.deploys.error) lines.push([dim(`  can't say: ${inc.deploys.error}`)]);
  else if (inc.deploys.within.length) for (const d of inc.deploys.within) lines.push([DOT(DEPLOY_COLOUR[d.status] ?? theme.warn), { text: `${time(d.start)}  `, color: theme.dim }, { text: `${d.author || 'someone'}  `, bold: true }, dim(`${d.deployer}  `), { text: d.message.split('\n')[0] }]);
  else lines.push([dim(`  none${inc.deploys.latest ? `; the latest before it was ${relTime(Date.parse(inc.deploys.latest.start))} earlier: ${inc.deploys.latest.message.split('\n')[0]}` : ''}`)]);
  lines.push(...head('The latest occurrence'));
  const colour = { request: theme.info, dependency: theme.dim, exception: theme.del, trace: undefined };
  if (!inc.rows.length) lines.push([dim('  not found in this span')]);
  for (const r of inc.rows) lines.push([dim(`${cellText(r.timestamp, 'datetime').slice(11)}  `), { text: String(r.itemType).padEnd(11), color: colour[r.itemType] }, { text: `${r.name ?? ''}  `, bold: r.itemType === 'exception' }, { text: `${r.detail ?? ''}`, color: r.success === false ? theme.del : theme.dim }, dim(r.duration != null ? `  ${Math.round(r.duration)} ms` : '')]);
  if (inc.frames.length) {
    lines.push(...head('Stack'));
    for (const f of inc.frames) lines.push([{ text: `  ${f.method ?? '?'}  ` }, dim(`${f.file}${f.line ? `:${f.line}` : ''}`)]);
  }
  lines.push(...head('Failing SQL'));
  if (!inc.sql.length) lines.push([dim('  none')]);
  for (const s of inc.sql) lines.push([{ text: `  ${s.count}× `, color: theme.del, bold: true }, { text: `${s.target}  `, color: theme.info }, dim(s.resultCode ? `error ${s.resultCode}  ` : ''), { text: String(s.data ?? '').replace(/\s+/g, ' ') }]);
  if (inc.repo) {
    lines.push(...head('Commits to its files in the 14 days before first seen'));
    if (inc.commits.error) lines.push([{ text: `  can't say: ${inc.commits.error}`, color: theme.del }]);
    else if (!inc.files.length) lines.push([dim(`  none of its frames is a file in ${inc.repo}`)]);
    else if (!inc.commits.length) lines.push([dim(`  none touched ${inc.files.map((f) => f.path).join(', ')}`)]);
    for (const c of Array.isArray(inc.commits) ? inc.commits : []) lines.push([{ text: `  ${c.hash.slice(0, 10)}  `, color: theme.warn }, dim(`${time(c.at).slice(0, 16)}  `), { text: `${c.author}  `, bold: true }, { text: c.subject }]);
  }
  return lines;
}

/** I on a problem and /incident [problem]; /incident save <file> writes the last one's write-up. */
export async function incident(ctx, which) {
  if (typeof which === 'string' && /^save(\s|$)/i.test(which.trim())) return saveIncident(ctx, which.trim().slice(4).trim());
  const problem = typeof which === 'object' && which ? which : problemNamed(ctx, which);
  if (!problem) return ctx.note(which?.trim() ? `No problem like ${which.trim()} in Problems.` : 'Pick a problem in Problems first (3), or name one.', 'error');
  const scope = await ctx.scope();
  if (!scope.component) return ctx.note(scope.why, 'error');
  const title = `Incident: ${problem.type}`;
  const token = {};
  ctx.showText(title, '', { loading: true, token });
  const still = () => ctx.overlay()?.token === token;
  try {
    const inc = await gatherIncident(ctx, scope.component, problem);
    inc.markdown = incidentMarkdown(inc);
    ctx.setIncident(inc);
    if (!still()) return;
    ctx.showText(title, inc.markdown, {
      lines: incidentLines(inc),
      token,
      hint: 'Y exception → Splice · T SQL → Trawl · H request → Hail · w write-up · s save',
      keys: incidentKeys(ctx, inc),
    });
  } catch (e) {
    if (still()) ctx.closeOverlay();
    ctx.note(e.message, 'error');
  }
}

/** The incident view's keys: what goes to the siblings, Claude's write-up, saving. */
function incidentKeys(ctx, inc) {
  return {
    Y: () => copyFor(ctx, 'splice', takeLine('exception', exceptionContext(inc.problem, inc.latest, inc.request))),
    H: () => (inc.request ? copyFor(ctx, 'hail', takeLine('request', requestContext(inc.request))) : ctx.note('Its latest occurrence has no request with an address to send again.', 'error')),
    T: () => sqlForTrawl(ctx, inc),
    w: () => writeup(ctx, inc),
    s: () => saveIncident(ctx),
  };
}

/** T in an incident: its failing SQL, each to copy as a query for Trawl (↵) or its server's /azure-sql line (a). */
function sqlForTrawl(ctx, inc) {
  if (!inc.sql.length) return ctx.note("No SQL failed in this problem's operations.", 'error');
  ctx.showPicker({
    title: `The SQL that failed with ${inc.problem.type}`,
    back: ctx.overlay(),
    hint: '↵ copy it as a query for Trawl · a its server\'s /azure-sql line',
    items: inc.sql.map((s) => ({ s, segments: [{ text: `${s.count}× `, color: theme.del, bold: true }, { text: `${s.target}  `, color: theme.info }, { text: String(s.data ?? '(no command text)').replace(/\s+/g, ' ') }] })),
    onPick: (it) => {
      const { server, database } = sqlTarget(it.s.target);
      copyFor(ctx, 'trawl', takeLine('query', { sql: it.s.data ?? '', ...(server ? { server } : {}), ...(database ? { database } : {}) }));
    },
    keys: {
      a: (it) => {
        const { server, database } = sqlTarget(it.s.target);
        if (!server) return ctx.note(`${it.s.target} names no server.`, 'error');
        // A server in this subscription goes through T's checks (the firewall, the login an app uses).
        const known = (ctx.data?.sqlServers ?? []).find((x) => x.fqdn?.toLowerCase() === server.toLowerCase() || x.name.toLowerCase() === server.toLowerCase());
        const db = known && database ? (known.databases ?? []).find((d) => d.name.toLowerCase() === database.toLowerCase()) : null;
        if (known) return openInTrawl(ctx, db ?? known);
        copyFor(ctx, 'trawl', shareLine('azure-sql', [server, ...(database ? [database] : [])]));
      },
    },
  });
}

/** w in an incident: Claude's draft write-up, in Markdown, in the viewer (s saves it). */
async function writeup(ctx, inc) {
  const back = ctx.overlay();
  const r = await ctx.task(
    `Asking Claude for a write-up of ${inc.problem.type}`,
    async (signal) => ({ stdout: await ctx.askClaude(writeupPrompt(inc.problem), { input: clip(inc.markdown, 60_000), cwd: ctx.cwd(), signal, tools: ['Read', 'Grep', 'Glob'] }) }),
    { label: 'Claude is writing it up' },
  );
  if (!r.ok) return r;
  inc.writeup = r.out;
  ctx.showText(`Write-up: ${inc.problem.type}`, r.out, { back, hint: 's save it', keys: { s: () => saveIncident(ctx) } });
  return r;
}

/** s in an incident and /incident save <file>: Claude's write-up when there is one, else the incident, to a Markdown file. */
export async function saveIncident(ctx, file) {
  const inc = ctx.incident();
  if (!inc) return ctx.note('Open an incident first: I on a problem, or /incident.', 'error');
  let name = String(file ?? '').trim().replace(/^"(.*)"$/, '$1');
  if (!name) name = (await ctx.askText({ title: inc.writeup ? "Save Claude's write-up as" : 'Save the incident as', detail: 'A Markdown file, in the folder Sonar started in unless you give a path.', value: incidentFile(inc.problem) }))?.trim();
  if (!name) return;
  const full = resolve(ctx.cwd(), name);
  try {
    await writeFile(full, `${(inc.writeup ?? inc.markdown).trimEnd()}\n`, 'utf8');
    ctx.note(`Wrote ${inc.writeup ? "Claude's write-up" : 'the incident'} to ${full}`, 'ok');
  } catch (e) {
    ctx.note(`Couldn't write ${full}: ${e.message}`, 'error');
  }
}

/**
 * K in Problems and /compare-window [deploy|<ISO time>]: two equal windows either side of a point (the
 * latest deployment of the app in scope, else the middle of the span; or the time given), and what
 * changed across it: exception types new, gone or at least twice as frequent, dependencies' p95
 * duration, operations failing (5xx) more often.
 */
export async function compareWindow(ctx, arg = '', { now = Date.now() } = {}) {
  const a = String(arg ?? '').trim();
  const scope = await ctx.scope();
  if (!scope.component) return ctx.note(scope.why, 'error');
  let point;
  let what;
  if (a && a.toLowerCase() !== 'deploy') {
    point = Date.parse(a);
    if (!(point < now)) return ctx.note(`${a} isn't a time in the past: give one like 2026-10-20T14:00Z, or deploy.`, 'error');
    what = cellText(new Date(point).toISOString(), 'datetime');
  } else {
    const target = scope.role ? appOfRole(ctx, scope.role) : null;
    const list = target ? await ctx.provider.deployments(target).catch(() => []) : [];
    const latest = list.filter((d) => d.status === 'succeeded' && Date.parse(d.start ?? '') < now).sort((x, y) => Date.parse(y.start) - Date.parse(x.start))[0];
    if (latest) {
      point = Date.parse(latest.end ?? latest.start);
      what = `the deployment ${relTime(Date.parse(latest.start), now)} ago (${latest.message.split('\n')[0]})`;
    } else if (a) return ctx.note(scope.role ? `${scope.role} has no deployment to compare around.` : "Pick an app first (p in Resources): a deployment is one app's.", 'error');
    else {
      point = now - (ctx.timespan().hours * 3600_000) / 2;
      what = `the middle of the last ${ctx.timespan().label}`;
    }
  }
  const w = windowsAround(point, now);
  const queries = compareQueries(scope.role, w);
  let found;
  const r = await ctx.task(
    `${scope.component.name}${scope.role ? ` · ${scope.role}` : ''}: before and after ${what}`,
    async (signal) => {
      const ask = (q) => ctx.provider.query(scope.component, q, { timespan: w.timespan, signal }).then(records);
      const [exceptions, dependencies, requests] = await Promise.all([ask(queries.exceptions), ask(queries.dependencies), ask(queries.requests)]);
      found = compareWindows({ exceptions, dependencies, requests });
      const n = found.fresh.length + found.gone.length + found.rising.length + found.deps.length + found.ops.length;
      return { stdout: n ? `${n} change${n === 1 ? '' : 's'} across it` : 'Nothing changed much across it' };
    },
    { label: 'Comparing' },
  );
  if (!r.ok) return r;
  // Rounded rather than cut short: a window just under three days is "3d".
  const h = w.len / 3600_000;
  const len = h < 1.5 ? `${Math.round(w.len / 60_000)}m` : h < 36 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`;
  const { lines, text } = comparisonLines(found, { what, len });
  ctx.showText(`Before and after ${what}`, text, { lines });
  return r;
}

/** /compare-window's answer as the viewer's lines and as text (what y copies). */
export function comparisonLines(c, { what, len }) {
  const dim = (t) => ({ text: t, color: theme.dim });
  const lines = [[dim(`The ${len} before it, against the ${len} after`)]];
  const section = (title, rows, row) => {
    lines.push([], [{ text: title, bold: true, color: theme.accent }]);
    if (!rows.length) lines.push([dim('  none')]);
    for (const x of rows) lines.push(row(x));
  };
  const pct = (x) => `${Math.round(x * 1000) / 10}%`;
  section('New exception types', c.fresh, (t) => [{ text: `  ${t.after}× `, color: theme.del, bold: true }, { text: `${t.type}  `, bold: true }, dim(t.message)]);
  section('Gone', c.gone, (t) => [{ text: `  ${t.before}× before  `, color: theme.add }, { text: t.type }]);
  section('At least twice as frequent', c.rising, (t) => [{ text: `  ${t.before} → ${t.after}  `, color: theme.warn, bold: true }, { text: t.type }]);
  section("Dependencies' p95 duration", c.deps, (d) => [{ text: `  ${Math.round(d.before)} → ${Math.round(d.after)} ms  `, color: d.change > 0 ? theme.del : theme.add, bold: true }, dim(`${d.change > 0 ? '+' : ''}${Math.round(d.change * 100)}%  `), { text: d.target }]);
  section('Operations failing more often (5xx)', c.ops, (o) => [{ text: `  ${pct(o.before)} → ${pct(o.after)}  `, color: theme.del, bold: true }, { text: o.name }]);
  return { lines, text: lines.map((l) => l.map((s) => s.text).join('')).join('\n') };
}

/** ↵ on an alert: everything Alerts Management says about it. */
export function showAlert(ctx, alert) {
  const rows = [
    ['severity', alert.severity],
    ['signal', `${alert.signal}${alert.service ? ` · ${alert.service}` : ''}`],
    ['state', `${alert.condition} · ${alert.state}`],
    ['fired', alert.fired ? `${cellText(alert.fired, 'datetime')} (${relTime(Date.parse(alert.fired))} ago)` : '—'],
    ['changed', alert.changed ? cellText(alert.changed, 'datetime') : '—'],
    ['target', `${alert.target}${alert.targetType ? `  (${alert.targetType})` : ''}`],
    ['group', alert.resourceGroup || '—'],
    ['rule', alert.rule?.split('/').pop() ?? '—'],
  ];
  const text = [alert.name, alert.description, '', ...rows.map(([k, v]) => `${k.padEnd(10)}${v}`), '', alert.id].filter((l, i) => i !== 1 || l).join('\n');
  const lines = [
    [{ text: alert.name, bold: true }],
    ...(alert.description ? [[{ text: alert.description, color: theme.dim }]] : []),
    [],
    ...rows.map(([k, v]) => [{ text: k.padEnd(10), color: theme.dim }, { text: v, color: k === 'severity' ? (/^Sev[01]$/.test(v) ? theme.del : theme.warn) : undefined }]),
    [],
    [{ text: 'o in Alerts opens its target in the portal', color: theme.dim }],
  ];
  ctx.showText(`Alert: ${alert.name}`, text, { lines });
}

/** /accent: a new accent colour, or `default` for the one Sonar comes with. */
export function accent(ctx, value) {
  const v = value.trim();
  if (v !== 'default' && !isColour(v)) return ctx.note('An accent is a colour like #5fafff (or default).', 'error');
  ctx.setConfig((c) => {
    const { accent: _, ...rest } = c;
    return v === 'default' ? rest : { ...c, accent: v };
  });
  setAccent(v === 'default' ? null : v);
  redrawSettings(ctx);
}

/** , and /settings: every setting in a list; ↵ changes the one under the cursor. */
export function settings(ctx, { replace = false, index } = {}) {
  ctx.showPicker(
    {
      title: 'Settings',
      index,
      items: () => settingRows(ctx.config, { file: configFile(), mouse: ctx.mouseAvailable }).map((row) => ({ row, segments: settingSegments(row) })),
      redraw: (at) => settings(ctx, { replace: true, index: at }),
      onPick: (it) => changeSetting(ctx, it.row),
    },
    { replace },
  );
}

/** Shows the settings again after a change, if they're what's on screen. */
export function redrawSettings(ctx) {
  const o = ctx.overlay();
  if (o?.redraw) o.redraw(o.index);
}

async function changeSetting(ctx, row) {
  if (row.action === 'toggle') {
    ctx.setConfig((c) => ({ ...c, [row.id]: c[row.id] === false }));
    return redrawSettings(ctx);
  }
  if (row.action === 'theme') {
    ctx.setConfig((c) => ({ ...c, theme: nextTheme(c) }));
    applyTheme(ctx.config);
    return redrawSettings(ctx);
  }
  if (row.action === 'accent') return ctx.prefill(`/accent ${ctx.config.accent ?? defaultAccent()}`);
  if (row.action === 'clear') {
    const ok = await ctx.confirm({ title: `Clear the prompt history (${row.value})?`, options: YES_NO('Yes, clear it') });
    if (!ok) return;
    ctx.setConfig((c) => ({ ...c, [row.id]: [] }));
    redrawSettings(ctx);
  }
}
