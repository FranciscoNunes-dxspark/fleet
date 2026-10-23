// Every user-facing operation, written once: keys and slash commands both call these with `ctx`
// (built in ui/App.jsx). Questions before anything destructive belong here too (ctx.confirm).
import { label } from './azure/arm.js';
import { clip } from './claude-cli.js';
import { configFile } from './config.js';
import { cellText, isProduction, looksSecret, operationQuery, records, settingsDiff } from './insights.js';
import { openUrl } from './open.js';
import { run } from './run.js';
import { nextTheme, settingRows, settingSegments } from './settings.js';
import { BULLET, applyTheme, defaultAccent, isColour, setAccent, theme } from './theme.js';
import { fit, relTime } from './text.js';

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
      return { stdout: await ctx.askClaude(whyPrompt(problem), { input, cwd: process.cwd(), signal, tools: ['Read', 'Grep', 'Glob'] }) };
    },
    { label: 'Claude is reading it' },
  );
  if (r.ok) ctx.showText(`Why ${problem.type}`, r.out);
  return r;
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
