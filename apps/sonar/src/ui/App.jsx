import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdin } from 'ink';
import * as a from '../actions.js';
import { label } from '../azure/arm.js';
import { SCHEMA, TIMESPANS, availabilityQuery, componentFor, problemsQuery, records, sparklines, starterQuery, trendQuery } from '../insights.js';
import { loadSubscription } from '../load.js';
import { costDay } from '../cost.js';
import { autoscaleFor } from '../scale.js';
import { crossing, watchEvery, watchValue } from '../watches.js';
import { mapLimited, targetForUrl, targetsByLabel } from '../tree.js';
import { COMMANDS, findCommand, suggestionsFor } from '../commands.js';
import { saveConfig } from '../config.js';
import { HELP } from '../help.js';
import { commandsSection, sectionFor } from '@fleet/kit/help-layout.js';
import { askHostToUpdate } from '@fleet/kit/hosted.js';
import { BULLET, theme } from '../theme.js';
import { fitSegments, stringWidth } from '@fleet/kit/text.js';
import { VERSION } from '../app.js';
import { useKeyTranslation, useTerminalSize } from '@fleet/kit/ui/hooks.js';
import { keymapSection, parseKeymap, shortcutKey, translateKey } from '@fleet/kit/keymap.js';
import { expandLines, userCommands } from '@fleet/kit/usercommands.js';
import { paletteItems } from '@fleet/kit/palette.js';
import { Palette } from '@fleet/kit/ui/Palette.jsx';
import { Confirm, Panel, PromptBox, Row, SecretPrompt, Spinner, Suggestions, confirmHeight } from '@fleet/kit/ui/parts.jsx';
import { HelpView } from '@fleet/kit/ui/HelpView.jsx';
import { LiveView } from './LiveView.jsx';
import { AlertsView } from './AlertsView.jsx';
import { LogsView } from './LogsView.jsx';
import { ProblemsView } from './ProblemsView.jsx';
import { ResourcesView } from './ResourcesView.jsx';
import { LogView } from './LogView.jsx';
import { Picker } from './Picker.jsx';
import { TextViewer } from './TextViewer.jsx';
import { WELCOME_HEIGHT, Welcome } from './Pet.jsx';
import { FACES, moodFor } from '../pet.js';
import { worthNotifying } from '../notify.js';
import { ask } from '@fleet/kit/claude-cli.js';
import { APP_NAMES, decodeContext, logActivity, pastedLine, readMoods, writeMood } from '@fleet/kit/family.js';
import { familyMood, moodKey, reactionLine, reactionTo } from '../kin.js';

const VIEWS = [
  { id: 'resources', label: 'Resources' },
  { id: 'logs', label: 'Logs' },
  { id: 'problems', label: 'Problems' },
  { id: 'live', label: 'Live' },
  { id: 'alerts', label: 'Alerts' },
  { id: 'log', label: 'Log' },
];

const VIEW_LABELS = Object.fromEntries(VIEWS.map((v) => [v.id, v.label]));

// What ? shows: help.js's sections, the keys you mapped, then the slash commands, yours with them.
const helpSections = (user, keymap) => [...HELP, ...[keymapSection(keymap, VIEW_LABELS)].filter(Boolean), commandsSection([...COMMANDS, ...user])];

// ctrl+p, as the terminal sends it: the command palette.
const CTRL_P = '\x10';
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const HINTS = {
  resources: '↵ settings · alt+r restart · alt+s stop/start · alt+w swap · alt+d deployments · f functions · l logs · p problems · alt+l live log · o portal · b browse · on SQL: alt+t Trawl, alt+f firewall',
  logs: 'e edit the query · ↵ run it / show a row · v chart/grid · s save it · h l columns · y copy the row · alt+y all · alt+h for Hail · alt+f as .http · c which insights',
  problems: '↵ the latest occurrence · alt+i incident · alt+k before/after · alt+q slowest SQL · w ask Claude why · l in Logs · y copy · alt+y for Splice · c which insights',
  alerts: '↵ the alert whole · o its target in the portal · ↵ on a test: its results in Logs · y copy the name · c which insights',
  live: 'j/k scroll back · alt+g follow · p pause · c clear · alt+r reconnect · y copy',
  log: '↵ all its output · y copy it',
};

// Only web and function apps and their slots have settings, logs to stream and Application Insights.
const webTarget = (t) => (t && !t.type ? t : null);

const firstLine = (s) => String(s ?? '').split('\n')[0];

function Header({ data, span, demo, width, loading, mood }) {
  const segs = [
    { text: `${FACES[mood]} `, color: theme.accent, bold: true },
    { text: 'Sonar', bold: true },
  ];
  if (demo) segs.push({ text: '  ' }, { text: ' DEMO ', bg: theme.info, color: theme.ink, bold: true });
  if (data) segs.push({ text: '  │  ', color: theme.border }, { text: data.subscription.name, bold: true }, { text: `  ${data.apps.length} apps${loading ? ' · reading…' : ''}`, color: theme.dim });
  else if (loading) segs.push({ text: '  loading…', color: theme.dim });
  segs.push({ text: '  │  last ', color: theme.dim }, { text: span.label, color: theme.warn, bold: true });
  return <Row pointer={false} width={width} segments={segs} />;
}

/** The tabs' labels and the columns each one covers (`from` up to `to`), which clicks are matched against. */
function tabLabels(entries) {
  let x = 0;
  return VIEWS.map((v, i) => {
    let label = ` ${i + 1} ${v.label}`;
    if (v.id === 'log' && entries.length) label += ` ${entries.length}`;
    label += ' ';
    const from = x;
    x += stringWidth(label) + 1;
    return { id: v.id, label, from, to: from + stringWidth(label) };
  });
}

function Tabs({ view, entries, width }) {
  const segs = [];
  for (const t of tabLabels(entries)) {
    const on = t.id === view;
    segs.push({ text: t.label, bg: on ? theme.accent : undefined, color: on ? theme.ink : theme.dim, bold: on }, { text: ' ' });
  }
  return <Row pointer={false} width={width} segments={segs} />;
}

// The last two results, Claude Code style: "● node --version" then "  ⎿  output".
function activityRows(entries) {
  const out = [];
  for (const e of entries.slice(-2)) {
    const color = { error: theme.del, ok: theme.accent, running: theme.dim, info: theme.info }[e.status];
    out.push([{ text: `${BULLET} `, color }, { text: e.title, bold: e.status !== 'info' }]);
    const max = e.status === 'error' ? 3 : 2;
    e.lines.slice(0, max).forEach((l, i) =>
      out.push([{ text: i === 0 ? '  ⎿  ' : '     ', color: theme.dim }, { text: l, color: e.status === 'error' ? theme.del : theme.dim }]),
    );
    if (e.lines.length > max) out.push([{ text: '     ' }, { text: `… +${e.lines.length - max} lines (/last to see all)`, color: theme.dim }]);
  }
  return out.slice(-6);
}

const DOUBLE_CLICK_MS = 400;

// `provider` is Azure (azure/arm.js's createAzure) or the demo (demo.js), the same interface; `load` reads
// a subscription through it (load.js). `open` is where to start, from the command line (a sibling such as
// Keel opens Sonar this way): { sub, app, url, insights, view: 'logs' | 'problems', kql }. `mouse` is mouse.js's
// terminalMouse() from cli.jsx (missing where the terminal can't report it); tests pass their own.
// `copy` puts text on the clipboard (cli.jsx's; tests pass a stub). `checkUpdate` and `installUpdate`
// come only in the downloaded builds, so tests and checkouts never go online or replace anything.
// `notify(title, body)` says a long job has finished (cli.jsx rings the terminal's bell and raises a
// desktop notification); tests pass a recorder or nothing. `askClaude` is claude-cli.js's ask (w in
// Problems); tests stub it.
// `cwd` is the folder Sonar started in: where Claude reads code, the checkout an incident's commits come
// from, and where files are written; tests pass their own.
// `familyEvery` is how often the siblings' moods are read (ms); tests make it short.
export function App({ config: initialConfig, provider, open, load = loadSubscription, checkUpdate, installUpdate, setTitle, mouse, copy, notify, askClaude = ask, cwd = process.cwd(), familyEvery = 30_000 }) {
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize();
  const [config, setConfigState] = useState(initialConfig);
  const [data, setData] = useState(null);
  // Counts the subscriptions read: once when one first shows, once when it's whole. What looks again
  // when the data changes (Problems, Alerts) follows this, not each step of a subscription filling in.
  const [dataStamp, setDataStamp] = useState(0);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState('resources');
  const [spanIndex, setSpanIndex] = useState(initialConfig.timespan ?? 1);
  const spanRef = useRef(spanIndex);
  // Logs: the query in the box and what the last run found. Problems: what was found, for which scope.
  const [query, setQuery] = useState('');
  const [result, setResult] = useState(null);
  const resultRef = useRef(null);
  resultRef.current = result;
  const [problems, setProblems] = useState(null);
  // Problems shows only those like an exception taken from a sibling (/take exception) until x.
  const [problemFilter, setProblemFilter] = useState(null);
  const [alerts, setAlerts] = useState(null);
  // What Logs and Problems look at: an app (l, p) or, with `all`, everything in the chosen component.
  const [scopeState, setScopeState] = useState({ target: null, component: null, all: false });
  const scopeRef = useRef(scopeState);
  const setScope = (s) => {
    scopeRef.current = s;
    setScopeState(s);
  };
  const [filter, setFilter] = useState('');
  // The app Resources starts on (sonar --app or --url), once it's been found.
  const [focusId, setFocusId] = useState(null);
  // Live: the app whose log streams (L, or the one picked in Resources), its lines, how it's going.
  const [liveTarget, setLiveTarget] = useState(null);
  const [live, setLive] = useState({ lines: [], status: 'idle', error: null, paused: false });
  const livePaused = useRef(false);
  const [liveTick, setLiveTick] = useState(0);
  const selectedRef = useRef(null);
  const selectedProblem = useRef(null);
  const problemsRef = useRef(null);
  problemsRef.current = problems;
  // The incident shown last (I in Problems), for /incident save.
  const incidentRef = useRef(null);
  const settingsCache = useRef(new Map());
  const metricsCache = useRef(new Map());
  const firewallCache = useRef(new Map());
  const adminCache = useRef(new Map());
  // Each app's and slot's Key Vault references, read in the background after a load (scanExtras).
  const refsCache = useRef(new Map());
  // Each app's ramp-up rules (routing.js), read with the references for the apps that have slots.
  const routingCache = useRef(new Map());
  // App Service plans by id, and each subscription's autoscale settings, kept until r or a scale.
  const planCache = useRef(new Map());
  const autoscaleCache = useRef(new Map());
  // A Log Analytics workspace's tables and columns, for completion in Logs; kept until r.
  const tablesCache = useRef(new Map());
  // What the list shows beside each app or slot, by id: { refs, routing } (its Key Vault references, an app's ramp-up rules).
  const [extras, setExtras] = useState({});
  // What each watch said last ({ value, above, error, at }), by name; only while Sonar runs.
  const watchStates = useRef(new Map());
  // This month's costs per subscription, read once a day (r doesn't read them again).
  const costCache = useRef(new Map());
  const [resolved, setResolved] = useState({ component: null, role: null, why: '' });
  const [focus, setFocusState] = useState('view');
  const [prompt, setPromptState] = useState({ value: '', cursor: 0 });
  const [sugIndex, setSugIndex] = useState(0);
  const [overlay, setOverlayState] = useState(null);
  const [confirmReq, setConfirmReq] = useState(null);
  const [entries, setEntries] = useState([]);
  const [busy, setBusy] = useState(null);
  const [welcome, setWelcome] = useState(true);
  const [update, setUpdate] = useState(null);
  // The pet looks happy (or worried) for a few seconds after a result; re-render when that wears off.
  const [, setMoodTick] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setMoodTick((n) => n + 1), 8100);
    return () => clearTimeout(t);
  }, [entries]);
  // A sibling's mood, said once by Ping in a line of its own until esc ({ app, mood, reason, at }).
  const [reaction, setReaction] = useState(null);
  const seenMoods = useRef(new Set());
  // A word in the bottom line for a moment ("Copied 3 lines"), where it moves nothing on screen.
  const [flash, setFlash] = useState(null);
  // What ctrl+c says when there's nothing selected to copy.
  const nothingToCopy = () => setFlash({ text: 'Drag over text to copy it · q quits' });
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 3000);
    return () => clearTimeout(t);
  }, [flash]);

  // Errors said and questions answered no, counted so a line of your own command knows it failed.
  const errorCount = useRef(0);
  const declines = useRef(0);
  // Your own commands and keys (the config's "commands" and "keys"), and what was wrong with them.
  const custom = useMemo(() => {
    const mine = userCommands(config.commands, COMMANDS.map((c) => c.name));
    const commands = mine.commands.map((c) => ({ ...c, run: (_, rest) => ctx.runUserCommand(c, rest) }));
    const keymap = parseKeymap(config.keys, VIEWS.map((v) => v.id));
    return { commands, keymap, sections: helpSections(commands, keymap), problems: [...mine.problems.map((p) => `commands: ${p}`), ...keymap.problems.map((p) => `keys: ${p}`)] };
  }, [config.commands, config.keys]);
  const customRef = useRef(custom);
  customRef.current = custom;
  const viewRef = useRef(view);
  viewRef.current = view;
  // A key picked in the palette, sent to the view once it's back on screen (the effect below).
  const pendingKey = useRef(null);

  // Async actions read the latest state through refs, not through stale closures.
  const dataRef = useRef(null);
  const busyRef = useRef(null);
  const configRef = useRef(config);
  const promptRef = useRef(prompt);
  const confirmRef = useRef(null);
  const nextId = useRef(1);
  const historyPos = useRef(-1);
  const lastOutput = useRef(null);
  // Counts keypresses, ahead of every handler, so the dispatcher can tell the key that opened the prompt.
  const keySeq = useRef(0);
  const prefillKey = useRef(-1);
  // The key that answered the last confirmation: it's that one's, and no other handler's.
  const answerKey = useRef(-1);
  const { internal_eventEmitter: inputEvents } = useStdin();
  useEffect(() => {
    if (!inputEvents) return;
    const count = () => keySeq.current++;
    inputEvents.prependListener('input', count);
    return () => inputEvents.removeListener('input', count);
  }, [inputEvents]);

  const setConfig = (update) => {
    const next = update(configRef.current);
    configRef.current = next;
    setConfigState(next);
    saveConfig(next);
  };

  const focusRef = useRef('view');
  const overlayRef = useRef(null);
  const setFocus = (f) => {
    focusRef.current = f;
    setFocusState(f);
  };
  const setOverlay = (next) => {
    const cur = overlayRef.current;
    let o = typeof next === 'function' ? next(cur) : next;
    // An overlay opened from a picker goes back to the picker when closed.
    if (o && o !== cur && !o.back && cur?.kind === 'picker' && typeof next !== 'function') o = { ...o, back: cur };
    overlayRef.current = o;
    setOverlayState(o);
  };
  const pickerIds = useRef(0);

  const setPrompt = (value, cursor = value.length) => {
    promptRef.current = { value, cursor };
    setPromptState(promptRef.current);
  };

  const addEntry = (e) => {
    if (e.status === 'error') errorCount.current++;
    const id = nextId.current++;
    setEntries((list) => [...list.slice(-99), { id, lines: [], at: Date.now(), ...e }]);
    return id;
  };
  const updateEntry = (id, patch) => {
    if (patch.status === 'error') errorCount.current++;
    setEntries((list) => list.map((e) => (e.id === id ? { ...e, at: Date.now(), ...patch } : e)));
  };

  const note = (text, status = 'info') => {
    const [title, ...lines] = String(text).split('\n');
    addEntry({ title, status, lines });
  };

  const loads = useRef(0);
  const reload = async (subId = dataRef.current?.subscription.id ?? configRef.current.subscription) => {
    setLoading(true);
    settingsCache.current = new Map();
    metricsCache.current = new Map();
    firewallCache.current = new Map();
    adminCache.current = new Map();
    refsCache.current = new Map();
    routingCache.current = new Map();
    planCache.current = new Map();
    autoscaleCache.current = new Map();
    tablesCache.current = new Map();
    // A subscription not on screen yet shows as soon as its apps are known, slots and databases
    // filling in as they come; reading the one on screen again keeps it until the new one is whole.
    const n = ++loads.current;
    const fresh = !dataRef.current || (subId != null && dataRef.current.subscription.id !== subId);
    let shown = false;
    const onProgress = fresh
      ? (d) => {
          if (n !== loads.current) return;
          dataRef.current = d;
          setData(d);
          if (!shown) setDataStamp((x) => x + 1);
          shown = true;
        }
      : undefined;
    try {
      const d = await load(provider, subId, { onProgress });
      dataRef.current = d;
      setData(d);
      setDataStamp((x) => x + 1);
      scanExtras(d, n);
    } catch (e) {
      note(`Couldn't read the subscription: ${firstLine(e.message)}`, 'error');
    } finally {
      setLoading(false);
    }
  };

  /**
   * Where the command line said to start: an app (by label, or the address it serves), an Application
   * Insights (by its AppId or name), and Logs or Problems about them. What can't be found is said.
   */
  const arrive = async ({ app, url, insights, view, kql }) => {
    const d = dataRef.current;
    if (!d) return;
    let target = null;
    if (app) {
      const all = targetsByLabel(d.apps, d.slots);
      target = all[app] ?? Object.values(all).find((t) => label(t).toLowerCase() === app.toLowerCase()) ?? null;
      if (!target) note(`There's no app called ${app} in ${d.subscription.name}. /sub picks another subscription.`, 'error');
    }
    if (url && !target) {
      target = targetForUrl(d.apps, d.slots, url);
      if (!target) note(`No app in ${d.subscription.name} serves ${url}: its address is neither an app's own nor one of its custom domains.`, 'error');
    }
    const component = insights ? (d.components.find((c) => c.appId === insights || c.name.toLowerCase() === insights.toLowerCase()) ?? null) : null;
    if (insights && !component) note(`There's no Application Insights ${insights} in ${d.subscription.name}.`, 'error');
    if (target) setFocusId(target.id);
    if (target || component) setScope({ target, component, all: !target });
    if (view === 'problems') setView('problems');
    else if (view === 'logs') await a.runQuery(ctx, kql ?? starterQuery(target?.name));
  };

  /** An app's or slot's settings, read once and kept until something changes them. */
  const settingsOf = (target) => {
    const cache = settingsCache.current;
    if (!cache.has(target.id)) {
      const p = provider.settings(target);
      p.catch(() => cache.delete(target.id));
      cache.set(target.id, p);
    }
    return cache.get(target.id);
  };

  /** An app's or slot's Key Vault references (keyvault.js), read once and kept until r or its settings change. */
  const referencesOf = (target) => {
    const cache = refsCache.current;
    if (!cache.has(target.id)) {
      const p = provider.keyVaultReferences ? provider.keyVaultReferences(target) : Promise.resolve([]);
      p.catch(() => cache.delete(target.id));
      cache.set(target.id, p);
    }
    return cache.get(target.id);
  };

  /** An app's ramp-up rules, read once and kept until r or /route changes them. */
  const routingOf = (app) => {
    const cache = routingCache.current;
    if (!cache.has(app.id)) {
      const p = provider.routing ? provider.routing(app) : Promise.resolve([]);
      p.catch(() => cache.delete(app.id));
      cache.set(app.id, p);
    }
    return cache.get(app.id);
  };

  /** After /route: the app's rules read again, and the list's marks with them. */
  const routingChanged = async (app) => {
    routingCache.current.delete(app.id);
    const routing = await routingOf(app).catch(() => null);
    setExtras((x) => ({ ...x, [app.id]: { ...x[app.id], routing } }));
  };

  /**
   * What completion in Logs offers for a component: Application Insights' tables, or a workspace's own
   * (insights.js SCHEMA when they can't be read).
   */
  const schemaOf = (component) => {
    if (!component?.workspaceId) return Promise.resolve(SCHEMA);
    const cache = tablesCache.current;
    if (!cache.has(component.workspaceId)) {
      const p = (provider.workspaceTables ? provider.workspaceTables(component) : Promise.resolve(SCHEMA)).then((t) => (Object.keys(t).length ? t : SCHEMA));
      p.catch(() => cache.delete(component.workspaceId));
      cache.set(component.workspaceId, p);
    }
    return cache.get(component.workspaceId);
  };

  /** An App Service plan by its id (scale.js planFrom), read once and kept until r or it's scaled. */
  const planOf = (planId) => {
    const key = String(planId).toLowerCase();
    const cache = planCache.current;
    if (!cache.has(key)) {
      const p = provider.plan ? provider.plan(planId) : Promise.reject(new Error("Plans can't be read here"));
      p.catch(() => cache.delete(key));
      cache.set(key, p);
    }
    return cache.get(key);
  };

  /** The autoscale settings that target plan `planId`, from the subscription's (read once, kept until r). */
  const autoscaleOf = async (planId) => {
    const sub = dataRef.current?.subscription.id;
    const cache = autoscaleCache.current;
    if (!cache.has(sub)) {
      const p = provider.autoscaleSettings ? provider.autoscaleSettings(sub) : Promise.resolve([]);
      p.catch(() => cache.delete(sub));
      cache.set(sub, p);
    }
    return autoscaleFor(await cache.get(sub), planId);
  };

  /**
   * What the list shows beside the apps and slots (Key Vault references that didn't resolve, the share of
   * traffic a slot takes), read in the
   * background after load `n`, four at a time, and drawn as it comes in (at most every 250 ms).
   */
  const scanExtras = async (d, n) => {
    const found = {};
    let said = 0;
    const flush = () => n === loads.current && setExtras({ ...found });
    const targets = d.apps.flatMap((app) => [app, ...(d.slots[app.id] ?? [])]);
    await mapLimited(targets, 4, async (t) => {
      if (n !== loads.current) return;
      const [refs, routing] = await Promise.all([referencesOf(t).catch(() => null), !t.slot && d.slots[t.id]?.length ? routingOf(t).catch(() => null) : null]);
      found[t.id] = { ...found[t.id], refs, ...(routing ? { routing } : {}) };
      if (Date.now() - said > 250) (said = Date.now()), flush();
    });
    flush();
  };

  /** An app's or slot's metrics over the time span, read when the cursor stops on it and kept until r. */
  const metricsOf = (target) => {
    const span = TIMESPANS[spanRef.current];
    const key = `${target.id}|${span.iso}`;
    const cache = metricsCache.current;
    if (!cache.has(key)) {
      const p = provider.metrics(target, { span });
      p.catch(() => cache.delete(key));
      cache.set(key, p);
    }
    return cache.get(key);
  };

  /** A SQL server's firewall rules, kept until r or a rule is added. */
  const firewallOf = (server) => {
    const cache = firewallCache.current;
    if (!cache.has(server.id)) {
      const p = provider.firewallRules(server);
      p.catch(() => cache.delete(server.id));
      cache.set(server.id, p);
    }
    return cache.get(server.id);
  };

  /** A SQL server's Entra admin (null when none is set, or it can't be read), the listing's when it carried one; kept until r. */
  const adminOf = (server) => {
    if (server.admin) return Promise.resolve(server.admin);
    const cache = adminCache.current;
    if (!cache.has(server.id)) cache.set(server.id, provider.sqlAdmin ? provider.sqlAdmin(server).catch(() => null) : Promise.resolve(null));
    return cache.get(server.id);
  };

  /**
   * Runs the watches (`names`, or all of them) against the Application Insights each was made in, quietly,
   * and says so, in the log and through `notify`, when one goes over its threshold.
   */
  const checkWatches = async (names) => {
    const list = (configRef.current.watches ?? []).filter((w) => !names || names.includes(w.name));
    await Promise.all(
      list.map(async (w) => {
        const was = watchStates.current.get(w.name);
        try {
          const value = watchValue(await provider.query(w.component, w.kql, { timespan: 'P1D' }));
          const { above, crossed } = crossing(was?.above, value, w.threshold);
          watchStates.current.set(w.name, { value, above, at: Date.now() });
          if (!crossed) return;
          note(`Watch "${w.name}" is ${value}, over ${w.threshold} (${w.component.name})\n${w.kql}`, 'error');
          logActivity('sonar', { text: `watch "${w.name}" is ${value}, over ${w.threshold} in ${w.component.name}`, kind: 'alert', project: cwd });
          if (notify && configRef.current.notify !== false) notify(`Sonar: ${w.name} is over ${w.threshold}`, `${value} in ${w.component.name}`);
        } catch (e) {
          watchStates.current.set(w.name, { ...(was ?? {}), error: firstLine(e.message), at: Date.now() });
        }
      }),
    );
  };

  /** The subscription's costs this month by resource, kept for the day; null when they can't be read (no permission, say nothing). */
  const costsOf = (subId) => {
    const key = `${subId}|${costDay()}`;
    const cache = costCache.current;
    if (!cache.has(key)) cache.set(key, provider.costs ? provider.costs(subId).catch(() => null) : Promise.resolve(null));
    return cache.get(key);
  };

  /** What Logs and Problems ask: the component (chosen, or the app's own) and the app's role name. */
  const resolveScope = async () => {
    const d = dataRef.current;
    if (!d) return { component: null, role: null, why: 'No subscription read yet.' };
    const s = scopeRef.current;
    const target = s.all ? null : (s.target ?? webTarget(selectedRef.current));
    let component = s.component;
    if (!component && target) component = componentFor(await settingsOf(target).catch(() => ({})), d.components);
    if (!component && d.components.length === 1) component = d.components[0];
    const why = target ? `${label(target)} reports to no Application Insights that Sonar can see: c picks one` : 'c picks an Application Insights to look in';
    return { component, role: target?.name ?? null, why: component ? '' : why };
  };

  // One command at a time, with the spinner, esc to cancel, and a line in the activity log.
  // `start(signal)` resolves with { stdout, stderr }.
  const task = async (title, start, { label = 'Working', refresh = false } = {}) => {
    if (busyRef.current) {
      note(`Wait for "${busyRef.current.label}" to finish (esc cancels it).`, 'error');
      return { ok: false, error: new Error('busy') };
    }
    const controller = new AbortController();
    const b = { label, started: Date.now(), abort: () => controller.abort() };
    busyRef.current = b;
    setBusy(b);
    const id = addEntry({ title, status: 'running' });
    setWelcome(false);
    // A long job that ends says so, for when you've looked away (Settings' "Notify when done").
    const tell = (line) => notify && worthNotifying(Date.now() - b.started, configRef.current) && notify(`Sonar: ${title}`, line ?? '');
    try {
      const { stdout = '', stderr = '' } = await start(controller.signal);
      const out = [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join('\n');
      lastOutput.current = { title, text: out || '(no output)' };
      updateEntry(id, { status: 'ok', lines: out ? out.split('\n') : ['Done'] });
      tell(out ? out.split('\n')[0] : 'Done');
      return { ok: true, out };
    } catch (error) {
      lastOutput.current = { title, text: error.message };
      updateEntry(id, { status: 'error', lines: error.cancelled ? ['Cancelled'] : error.message.split('\n') });
      if (!error.cancelled) tell(firstLine(error.message));
      return { ok: false, error };
    } finally {
      busyRef.current = null;
      setBusy(null);
      if (refresh) await reload();
    }
  };

  const confirm = (req) =>
    new Promise((done) => {
      const full = { options: [{ label: 'Yes', value: true }, { label: 'No', value: false }], ...req, id: nextId.current++, done };
      confirmRef.current = full;
      setConfirmReq(full);
    });
  const onConfirm = (value) => {
    const req = confirmRef.current;
    confirmRef.current = null;
    answerKey.current = keySeq.current;
    if (value === false || value == null) declines.current++;
    setConfirmReq(null);
    req?.done(value);
  };

  const prefill = (text, cursor = text.length) => {
    setPrompt(text, cursor);
    setSugIndex(0);
    historyPos.current = -1;
    setFocus('prompt');
    // Noted so that the key that did this isn't also typed into the prompt (see the dispatcher).
    prefillKey.current = keySeq.current;
  };

  const targetsMemo = useRef({ data: null, targets: {} });
  const ctxRef = useRef(null);
  if (!ctxRef.current) ctxRef.current = { get data() { return dataRef.current; }, get config() { return configRef.current; }, mouseHandlers: [] };
  const ctx = ctxRef.current;
  Object.assign(ctx, {
    task,
    provider,
    openSubscription: async (id) => {
      setScope({ target: null, component: null, all: false });
      setResult(null);
      setProblems(null);
      setAlerts(null);
      setFilter('');
      await reload(id);
      if (dataRef.current) setConfig((c) => ({ ...c, subscription: dataRef.current.subscription.id }));
    },
    // Whatever is under the cursor in Resources; selectedTarget is only ever a web or function app (or slot).
    selectTarget: (t) => (selectedRef.current = t),
    selectedResource: () => selectedRef.current,
    // The problem under the cursor in Problems, and the list there (for /why to name one).
    selectProblem: (p) => (selectedProblem.current = p),
    setProblemFilter,
    selectedProblem: () => selectedProblem.current,
    problems: () => problemsRef.current?.rows ?? [],
    problemSpark: (id) => problemsRef.current?.spark?.[id] ?? '',
    setIncident: (inc) => (incidentRef.current = inc),
    incident: () => incidentRef.current,
    cwd: () => cwd,
    askClaude,
    selectedTarget: () => webTarget(selectedRef.current),
    // Worked out once per subscription read, not on every key typed in the prompt.
    targets: () => {
      const d = dataRef.current;
      if (!d) return {};
      if (targetsMemo.current.data !== d) targetsMemo.current = { data: d, targets: targetsByLabel(d.apps, d.slots) };
      return targetsMemo.current.targets;
    },
    settingsOf,
    metricsOf,
    firewallOf,
    adminOf,
    costsOf,
    checkWatches,
    watchState: (name) => watchStates.current.get(name) ?? null,
    forgetWatch: (name) => watchStates.current.delete(name),
    forgetFirewall: (server) => firewallCache.current.delete(server.id),
    forgetSettings: (target) => (settingsCache.current.delete(target.id), refsCache.current.delete(target.id)),
    referencesOf,
    planOf,
    schemaOf,
    routingOf,
    routingChanged,
    autoscaleOf,
    forgetPlan: (planId) => planCache.current.delete(String(planId).toLowerCase()),
    extras: () => extras,
    scope: resolveScope,
    timespan: () => TIMESPANS[spanRef.current],
    setQuery,
    setResult,
    result: () => resultRef.current,
    setFilter,
    setComponent: (component) => setScope({ target: null, component, all: Boolean(component) }),
    chooseComponent: () => a.chooseComponent(ctx),
    // l on an app: Logs about it, with its latest requests to start from (or `kql`, from Problems).
    logsFor: (target, kql) => {
      if (target) setScope({ target, component: null, all: false });
      setView('logs');
      a.runQuery(ctx, kql ?? starterQuery(target?.name ?? scopeRef.current.target?.name));
    },
    liveFor: (target) => {
      setLiveTarget(target);
      setView('live');
    },
    live: {
      pause: () => {
        livePaused.current = !livePaused.current;
        setLive((l) => ({ ...l, paused: livePaused.current }));
      },
      clear: () => setLive((l) => ({ ...l, lines: [] })),
      reconnect: () => setLiveTick((n) => n + 1),
    },
    problemsFor: (target) => {
      setScope({ target, component: null, all: false });
      setView('problems');
    },
    note,
    confirm,
    // A masked field in the confirm's place: resolves { value } (or null on esc). askText shows what's typed.
    askSecret: (req) => confirm({ ...req, secret: true, options: [] }),
    askText: async (req) => (await confirm({ ...req, secret: true, plain: true, options: [] }))?.value ?? null,
    // A view that takes keys the app would otherwise use (a search being typed) sets this to say so.
    claimsKey: null,
    prefill,
    reload,
    setView,
    // Whether this terminal can report the mouse at all (/settings says so).
    mouseAvailable: Boolean(mouse),
    // /update: asks for the latest release now, whatever the daily check last said, and installs it.
    updateNow: () => {
      if (askHostToUpdate()) return note('Asked Fleet to look for a new version of the whole fleet.');
      if (!checkUpdate) return note(`This Sonar (${VERSION}) runs from a checkout: git pull updates it.`);
      if (update?.state === 'installing') return note(`Sonar ${update.latest} is being installed already.`);
      if (update?.state === 'installed') return note(`Sonar ${update.latest} is installed. It starts the next time you open Sonar.`);
      const said = (text) => ({ stdout: text, stderr: '' });
      return task(
        'Looking for a new version of Sonar',
        async () => {
          const { checked, newer } = await checkUpdate(null);
          setConfig((c) => ({ ...c, lastUpdateCheck: checked }));
          if (!newer) return said(`Sonar ${VERSION} is the latest version.`);
          if (!installUpdate) {
            setUpdate({ ...checked, state: 'out' });
            return said(`Sonar ${checked.latest} is out (you have ${VERSION}). Download it from ${checked.url}`);
          }
          setUpdate({ ...checked, state: 'installing' });
          try {
            await installUpdate(checked.latest);
          } catch (e) {
            setUpdate({ ...checked, state: 'out' });
            throw new Error(`Sonar ${checked.latest} is out, but it couldn't be installed: ${firstLine(e.message)}\nDownload it from ${checked.url}`);
          }
          setUpdate({ ...checked, state: 'installed' });
          return said(`Sonar ${checked.latest} is installed. It starts the next time you open Sonar.`);
        },
        { label: 'Updating Sonar' },
      );
    },
    // y in the views: `text` to the clipboard, said in the bottom line as "Copied <what>".
    copy: (text, what = text) => {
      if (!copy) return note("Copying to the clipboard isn't available here.", 'error');
      copy(text);
      setFlash({ text: `Copied ${what}` });
    },
    // Views call this first in their key handlers, for the same reason as the dispatcher below.
    viewHasKeys: () => focusRef.current === 'view' && !overlayRef.current && !confirmRef.current && answerKey.current !== keySeq.current,
    overlayHasKeys: () => focusRef.current === 'view' && !confirmRef.current && answerKey.current !== keySeq.current,
    quit: () => exit(),
    refresh: () => {
      reload();
      setProblemsTick((n) => n + 1);
    },
    // `token` marks a viewer that's filled in later (shown loading first): the same token replaces it,
    // keeping where it goes back to.
    showText: (title, text, opts = {}) => {
      if (opts.token && overlayRef.current?.token === opts.token) return setOverlay((cur) => ({ title, text, ...opts, back: cur?.back }));
      setOverlay({ title, text, ...opts });
    },
    // A list to pick from: { title, hint, items | load, onPick, keys, empty } (see Picker.jsx).
    // `replace`: swaps the picker on screen for this one (the same list, redrawn after a change), keeping
    // where it goes back to, instead of opening on top of it.
    showPicker: (picker, { replace = false } = {}) => {
      const next = { ...picker, kind: 'picker', id: ++pickerIds.current };
      if (replace) setOverlay((cur) => ({ ...next, back: cur?.back }));
      else setOverlay(next);
    },
    overlay: () => overlayRef.current,
    // Settings change through App's copy, the only one written to disk (ctx.config reads it).
    setConfig,
    closeOverlay: () => {
      const closing = overlayRef.current;
      // As a function, so a picker going back to another picker isn't given this one to return to.
      setOverlay((cur) => cur?.back ?? null);
      closing?.onClosed?.();
    },
    // On the section for the view on screen.
    showHelp: () => setOverlay({ kind: 'help', start: sectionFor(customRef.current.sections, view) }),
    // Your own command `cmd` (usercommands.js) with what was typed after it, and any line as typed at
    // the prompt; both resolve false when it failed.
    runUserCommand: (cmd, rest) => runUserCommand(cmd, rest),
    runLine: (text) => runLine(text),
    openPalette: () => openPalette(),
    showLast: () => (lastOutput.current ? setOverlay({ ...lastOutput.current }) : note('No command has run yet.')),
  });

  // One line as typed at the prompt: a shell command after !, else a slash command. Resolves false
  // when it failed: it threw, said an error, or a question it asked was answered no (so your own
  // commands stop there).
  const runLine = async (text) => {
    const [errors, declined] = [errorCount.current, declines.current];
    try {
      let r;
      if (text.startsWith('!')) r = await a.raw(ctx, text.slice(1));
      // A context a sibling copied, typed or pasted on its own: /take's.
      else if (decodeContext(text)) r = await a.take(ctx, text);
      else {
        const [, name, rest] = text.replace(/^\//, '').match(/^(\S+)\s*([\s\S]*)$/);
        const cmd = findCommand(name, customRef.current.commands);
        if (!cmd) {
          note(`Unknown command: /${name}. Type / to see them all.`, 'error');
          return false;
        }
        r = await cmd.run(ctx, rest.trim());
      }
      return r !== false && r?.ok !== false && errorCount.current === errors && declines.current === declined;
    } catch (e) {
      note(firstLine(e.message), 'error');
      return false;
    }
  };

  // One of your own commands: its lines in order, with what was typed after it filled in, stopping at
  // the first that fails. Commands of yours may run each other, but not round in a circle.
  const userDepth = useRef(0);
  const runUserCommand = async (cmd, rest) => {
    if (userDepth.current >= 5) {
      note(`/${cmd.name}: your commands run each other round in a circle, so it stopped.`, 'error');
      return false;
    }
    const lines = expandLines(cmd, rest);
    userDepth.current++;
    try {
      for (const [i, line] of lines.entries()) {
        if (await runLine(line)) continue;
        if (i < lines.length - 1) note(`/${cmd.name} stopped at ${line}: the ${plural(lines.length - i - 1, 'line')} after it didn't run.`, 'error');
        return false;
      }
      return true;
    } finally {
      userDepth.current--;
    }
  };

  const submit = async (raw) => {
    const text = raw.trim();
    setPrompt('');
    setFocus('view');
    if (!text) return;
    const history = [text, ...(configRef.current.history ?? []).filter((h) => h !== text)].slice(0, 100);
    setConfig((c) => ({ ...c, history }));
    await runLine(text);
  };

  // ctrl+p: the palette, over the view, starting from what's typed in the prompt when it's open there.
  const openPalette = () => {
    const typed = focusRef.current === 'prompt' ? promptRef.current.value.trim() : '';
    if (focusRef.current === 'prompt') setFocus('view');
    setOverlay({ kind: 'palette', query: typed.startsWith('!') ? '' : typed.replace(/^\//, '') });
  };
  // What's picked in it: a key goes to the view, a command runs, or waits in the prompt for what it
  // takes. After every handler has had the ↵ that picked it, so it isn't also the prompt's.
  const runPicked = (it) =>
    queueMicrotask(() => {
      ctx.closeOverlay();
      if (it.key) pendingKey.current = it.key.seq;
      else if (it.ask) prefill(`${it.command} `);
      else runLine(it.command);
    });

  // Your keys, where they come in: while a view has the keys (never while typing, in a confirm or
  // over an overlay), a key you mapped becomes the key it stands for, for the view and App alike, or
  // runs its command line. Then ctrl+p opens the palette, from a view or the prompt.
  const sendKey = useKeyTranslation((input) => {
    let out = input;
    if (focusRef.current === 'view' && !overlayRef.current && !confirmRef.current && !ctx.claimsKey?.(input, {})) {
      const b = translateKey(customRef.current.keymap, viewRef.current, input);
      if (b?.command) {
        queueMicrotask(() => runLine(b.command));
        return null;
      }
      if (b?.key) out = b.key.seq;
    }
    // Uppercase shortcuts are alt+letter (caps lock can't fire them); typing in a view is left alone.
    if (out === input && focusRef.current === 'view' && !confirmRef.current && !['palette', 'help'].includes(overlayRef.current?.kind) && !ctx.claimsKey?.(input, {})) out = shortcutKey(input);
    if (out == null) return null;
    if (out === CTRL_P && !overlayRef.current && !confirmRef.current && (focusRef.current === 'view' || focusRef.current === 'prompt')) {
      openPalette();
      return null;
    }
    return out;
  });
  useEffect(() => {
    if (pendingKey.current == null || overlayRef.current) return;
    const k = pendingKey.current;
    pendingKey.current = null;
    sendKey(k);
  });

  // The log streams while Live is on screen, and stops when you leave it or pick another app. Lines
  // come in bursts, so they're gathered and drawn a few times a second, the last 2000 kept.
  const streamTarget = view === 'live' ? (liveTarget ?? webTarget(selectedRef.current)) : null;
  useEffect(() => {
    if (!streamTarget) return;
    const controller = new AbortController();
    let pending = [];
    setLive((l) => ({ ...l, status: 'connecting', error: null }));
    const flush = setInterval(() => {
      if (!pending.length) return;
      const add = pending;
      pending = [];
      setLive((l) => ({ ...l, status: 'streaming', lines: [...l.lines, ...add].slice(-2000) }));
    }, 150);
    provider
      .logStream(streamTarget, { signal: controller.signal, onLine: (line) => !livePaused.current && pending.push(line) })
      .then(
        () => !controller.signal.aborted && setLive((l) => ({ ...l, status: 'ended' })),
        (e) => !controller.signal.aborted && setLive((l) => ({ ...l, status: 'error', error: firstLine(e.message) })),
      );
    return () => {
      controller.abort();
      clearInterval(flush);
    };
  }, [streamTarget?.id, liveTick]);

  // The watches run every few minutes (the Watch every setting) for as long as Sonar runs.
  const watchCount = (config.watches ?? []).length;
  const watchMs = watchEvery(config) * 60_000;
  useEffect(() => {
    if (!watchCount) return;
    const t = setInterval(() => checkWatches(), watchMs);
    return () => clearInterval(t);
  }, [watchCount, watchMs]);

  // Ping's mood goes to the family whenever it changes, and the siblings' are read every 30 s: a worried,
  // sad or happy one from the last 15 minutes is said once. The Family moods setting turns both off.
  const familyOn = config.familyMoods !== false;
  const said = familyMood(moodFor({ data, busy, lastEntry: entries.at(-1) }), { busy, lastEntry: entries.at(-1), data });
  useEffect(() => {
    if (familyOn) writeMood('sonar', said);
  }, [said.mood, said.reason, familyOn]);
  useEffect(() => {
    if (!familyOn) return setReaction(null);
    const look = () => {
      const m = reactionTo(readMoods('sonar'), seenMoods.current);
      if (!m) return;
      seenMoods.current.add(moodKey(m));
      setReaction(m);
    };
    look();
    const t = setInterval(look, familyEvery);
    return () => clearInterval(t);
  }, [familyOn, familyEvery]);
  // A word that's been there two minutes has been seen.
  useEffect(() => {
    if (!reaction) return;
    const t = setTimeout(() => setReaction(null), 120_000);
    return () => clearTimeout(t);
  }, [reaction]);

  // Problems are looked for when the view shows, and again when what it looks at or the span changes.
  const [problemsTick, setProblemsTick] = useState(0);
  const scopeKey = `${scopeState.target?.id ?? ''}|${scopeState.component?.id ?? ''}|${scopeState.all}|${view === 'problems' ? selectedRef.current?.id : ''}`;
  useEffect(() => {
    if (view !== 'problems' && view !== 'logs' && view !== 'alerts') return;
    let live = true;
    resolveScope().then((r) => live && setResolved(r));
    return () => {
      live = false;
    };
  }, [view, scopeKey, dataStamp]);
  useEffect(() => {
    if (view !== 'problems' || !data) return;
    const controller = new AbortController();
    const span = TIMESPANS[spanIndex];
    (async () => {
      const scope = await resolveScope();
      if (!scope.component) return setProblems({ rows: [], error: scope.why, span });
      setProblems((p) => ({ ...(p ?? {}), loading: true, span }));
      try {
        const opts = { timespan: span.iso, signal: controller.signal };
        const [list, trend] = await Promise.all([provider.query(scope.component, problemsQuery(scope.role), opts), provider.query(scope.component, trendQuery(scope.role, span), opts)]);
        if (!controller.signal.aborted) setProblems({ rows: records(list), spark: sparklines(records(trend)), span });
      } catch (e) {
        if (!controller.signal.aborted) setProblems({ rows: [], error: firstLine(e.message), span });
      }
    })();
    return () => controller.abort();
  }, [view, scopeKey, spanIndex, problemsTick, dataStamp]);

  // Alerts: what's firing in the subscription, and the availability tests of the Application Insights in scope.
  useEffect(() => {
    if (view !== 'alerts' || !data) return;
    const controller = new AbortController();
    const span = TIMESPANS[spanIndex];
    const opts = { span, signal: controller.signal };
    setAlerts((a) => ({ ...(a ?? {}), loading: true, span }));
    (async () => {
      const [fired, tests] = await Promise.allSettled([
        provider.alerts(data.subscription.id, opts),
        resolveScope().then((scope) => (scope.component ? provider.query(scope.component, availabilityQuery(), { timespan: span.iso, signal: controller.signal }).then(records) : Promise.reject(new Error(scope.why)))),
      ]);
      if (controller.signal.aborted) return;
      setAlerts({
        span,
        rows: fired.status === 'fulfilled' ? fired.value : [],
        error: fired.status === 'rejected' ? firstLine(fired.reason.message) : null,
        tests: tests.status === 'fulfilled' ? tests.value : [],
        testsError: tests.status === 'rejected' ? firstLine(tests.reason.message) : null,
      });
    })();
    return () => controller.abort();
  }, [view, scopeKey, spanIndex, problemsTick, dataStamp]);

  useEffect(() => {
    if (custom.problems.length) {
      const text = ['Some of your commands or keys in the config were left out:', ...custom.problems].join('\n');
      note(text, 'error');
      lastOutput.current = { title: 'Your commands and keys', text };
    }
    (async () => {
      await reload(open?.sub);
      if (open) await arrive(open);
      // After the first load, so it doesn't slow it down.
      if (checkUpdate && configRef.current.checkForUpdates !== false) {
        checkUpdate(configRef.current.lastUpdateCheck).then(
          ({ checked, newer }) => {
            setConfig((c) => ({ ...c, lastUpdateCheck: checked }));
            if (!newer) return;
            const outNote = (why = '') => note(`Sonar ${checked.latest} is out (you have ${VERSION})${why}.\nDownload it from ${checked.url}`);
            if (!installUpdate || configRef.current.autoUpdate === false) {
              setUpdate({ ...checked, state: 'out' });
              return outNote();
            }
            // In the background, without the spinner: nothing waits on it, and it only counts from the next start.
            setUpdate({ ...checked, state: 'installing' });
            installUpdate(checked.latest).then(
              () => {
                setUpdate({ ...checked, state: 'installed' });
                note(`Sonar ${checked.latest} is installed. It starts the next time you open Sonar.`);
              },
              (e) => {
                setUpdate({ ...checked, state: 'out' });
                outNote(`, but it couldn't be installed: ${firstLine(e.message)}`);
              },
            );
          },
          // Offline, or no way to ask: try again next time.
          () => {},
        );
      }
    })();
  }, []);

  // cli.jsx passes the terminal's title setter; tests pass a stub or nothing.
  const title = data ? `${data.subscription.name} — Sonar` : 'Sonar';
  useEffect(() => {
    setTitle?.(title);
  }, [title]);

  const suggestions = focus === 'prompt' && !confirmReq ? suggestionsFor(prompt.value, { user: customRef.current.commands, data, targets: ctx.targets(), problems: ctx.problems(), queries: Object.keys(configRef.current.savedQueries ?? {}) }) : [];
  const sel = Math.min(sugIndex, Math.max(0, suggestions.length - 1));

  // Line editing in the prompt.
  const promptKeys = (input, key) => {
    const { value, cursor } = promptRef.current;
    const items = suggestionsFor(value, { user: customRef.current.commands, data: dataRef.current, targets: ctx.targets(), problems: ctx.problems(), queries: Object.keys(configRef.current.savedQueries ?? {}) });
    const pick = items[Math.min(sugIndex, items.length - 1)];
    const edit = (v, c) => {
      setPrompt(v, c);
      setSugIndex(0);
    };
    // ctrl+c never quits: a mouse selection takes it first (mouse.js), so here it clears the line
    // or says how to copy.
    if (key.ctrl && input === 'c') return value ? edit('', 0) : nothingToCopy();
    if (key.escape) return setFocus('view');
    if (key.return) {
      if (pick && value.trim() !== pick.insert.trim()) return pick.run ? submit(pick.insert) : edit(pick.insert);
      return submit(value);
    }
    if (key.tab) return pick ? edit(pick.insert) : undefined;
    if (key.upArrow || key.downArrow) {
      if (items.length) return setSugIndex((s) => (s + (key.upArrow ? items.length - 1 : 1)) % items.length);
      const history = configRef.current.history ?? [];
      const pos = Math.max(-1, Math.min(history.length - 1, historyPos.current + (key.upArrow ? 1 : -1)));
      historyPos.current = pos;
      return setPrompt(pos < 0 ? '' : history[pos]);
    }
    if (key.leftArrow) return setPrompt(value, Math.max(0, cursor - 1));
    if (key.rightArrow) return setPrompt(value, Math.min(value.length, cursor + 1));
    // Most terminals send DEL for backspace, which Ink reports as `delete`.
    if (key.backspace || key.delete) {
      if (!value) return setFocus('view');
      if (cursor > 0) edit(value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1);
      return;
    }
    if (key.ctrl && input === 'a') return setPrompt(value, 0);
    if (key.ctrl && input === 'e') return setPrompt(value, value.length);
    if (key.ctrl && input === 'u') return edit(value.slice(cursor), 0);
    if (key.ctrl && input === 'w') {
      const start = value.slice(0, cursor).replace(/\S+\s*$/, '').length;
      return edit(value.slice(0, start) + value.slice(cursor), start);
    }
    if (key.ctrl || key.meta || !input) return;
    const text = input.replace(/[\r\n]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '');
    if (text) edit(value.slice(0, cursor) + text + value.slice(cursor), cursor + text.length);
  };

  // Keys that work in every view.
  const globalKeys = (input, key) => {
    if (key.escape) {
      if (busyRef.current) busyRef.current.abort();
      else {
        setEntries((list) => list.map((e) => ({ ...e, shown: false })));
        setWelcome(false);
        setReaction(null);
      }
      return;
    }
    if (input === '/' || input === ':') return prefill('/');
    if (input === '!') return prefill('!');
    if (input === '?') return ctx.showHelp();
    if (input === ',') return a.settings(ctx);
    if (input === 'q') return exit();
    const n = Number(input);
    if (n >= 1 && n <= VIEWS.length) return setView(VIEWS[n - 1].id);
    if (key.tab) {
      const i = VIEWS.findIndex((v) => v.id === view);
      return setView(VIEWS[(i + (key.shift ? VIEWS.length - 1 : 1)) % VIEWS.length].id);
    }
    if (input === 'r') return ctx.refresh();
    if (input === 't') {
      const next = (spanRef.current + 1) % TIMESPANS.length;
      spanRef.current = next;
      setSpanIndex(next);
      setConfig((c) => ({ ...c, timespan: next }));
      return note(`Looking at the last ${TIMESPANS[next].label}`);
    }
  };

  // One dispatcher reading focus from refs, which change the instant focus moves. Handlers that
  // switch on with the next render would let fast typing (or a paste) after "/" leak into the view.
  useInput((input, key) => {
    // Ink calls the handlers for a key in no fixed order. When a view's ran first and opened the prompt,
    // this same key mustn't then be typed into it.
    if (focusRef.current === 'prompt' && !confirmRef.current) return prefillKey.current === keySeq.current ? undefined : promptKeys(input, key);
    if (key.ctrl && input === 'c') return nothingToCopy();
    if (confirmRef.current || overlayRef.current || answerKey.current === keySeq.current) return;
    if (ctx.claimsKey?.(input, key)) return;
    // A command or a sibling's context pasted while a view has the keys goes into the prompt, to run with ↵.
    // (A terminal ends a pasted line with \r, which the family's rule takes as a \n.)
    const pasted = pastedLine(input);
    if (pasted) return prefill(pasted);
    globalKeys(input, key);
  });

  // The terminal reports the mouse while the setting is on (it is unless set off).
  useEffect(() => {
    mouse?.enable(config.mouse !== false);
  }, [config.mouse]);

  // Where things were drawn, for matching clicks against (set as the layout below is worked out).
  const layout = useRef(null);
  const lastPress = useRef(null);
  // The component under a point of the main area (`y` counted from its top), and that `y` in it.
  const mouseTarget = (y) => {
    const target = ctx.mouseHandlers.findLast((h) => h.top <= y);
    return target && { target, y: y - target.top };
  };
  const onMouse = (e) => {
    if (e.type === 'copy') {
      const n = e.text.split('\n').length;
      return setFlash({ text: n > 1 ? `Copied ${n} lines` : `Copied ${e.text.length} character${e.text.length === 1 ? '' : 's'}` });
    }
    if (e.button === 'left' && !e.release && !e.drag) {
      const prev = lastPress.current;
      const now = Date.now();
      const count = prev && prev.x === e.x && prev.y === e.y && now - prev.at < DOUBLE_CLICK_MS ? prev.count + 1 : 1;
      e.double = count === 2;
      e.triple = count === 3;
      // A fourth click starts over rather than counting on.
      lastPress.current = count < 3 ? { x: e.x, y: e.y, at: now, count } : null;
    } else if (!e.drag && e.button !== 'wheel') return;
    // A confirmation's options are picked with keys.
    if (confirmRef.current || !layout.current) return;
    const { mainTop, mainH, promptTop, sugCount, tabs } = layout.current;
    if (e.drag) {
      // A drag the component it started in takes itself (claimDrags below; useMouse's `drags`).
      const hit = mouseTarget(e.from.y - mainTop);
      if (!hit) return;
      if (focusRef.current === 'prompt') setFocus('view');
      return hit.target.handle({ ...e, y: e.y - mainTop - hit.target.top, from: { x: e.from.x, y: hit.y } });
    }
    if (e.y === mainTop - 1 && !e.wheel) {
      const tab = tabs.find((t) => e.x >= t.from && e.x < t.to);
      if (!tab) return;
      // Whatever is open over the view closes: a click on a tab should never do nothing.
      for (let n = 0; overlayRef.current && n < 20; n++) ctx.closeOverlay();
      setFocus('view');
      return setView(tab.id);
    }
    if (e.y >= mainTop && e.y < mainTop + mainH) {
      // Like esc, a click on the view leaves the prompt's text for later.
      if (!e.wheel && focusRef.current === 'prompt') setFocus('view');
      const hit = mouseTarget(e.y - mainTop);
      return hit?.target.handle({ ...e, y: hit.y });
    }
    if (e.wheel) return;
    if (e.y >= promptTop && e.y < promptTop + 3) {
      // The text starts after the border, the padding and "> ", scrolled as PromptBox scrolls it.
      const { value, cursor } = promptRef.current;
      const inner = columns - 6;
      const start = focusRef.current === 'prompt' ? Math.max(0, cursor - inner + 1) : 0;
      setPrompt(value, Math.max(0, Math.min(value.length, start + e.x - 4)));
      return setFocus('prompt');
    }
    const sug = e.y - promptTop - 3;
    if (sug >= 0 && sug < sugCount) {
      setSugIndex(sug);
      // As ↵ would, on the suggestion under the pointer.
      if (e.double) promptKeys('', { return: true });
    }
  };
  const mouseRef = useRef(onMouse);
  mouseRef.current = onMouse;
  useEffect(() => mouse?.subscribe((e) => mouseRef.current(e)), [mouse]);
  // Drags that start where the component on screen selects for itself skip the screen selection.
  useEffect(
    () =>
      mouse?.claimDrags?.((e) => {
        const at = layout.current;
        if (confirmRef.current || !at || e.y < at.mainTop || e.y >= at.mainTop + at.mainH) return false;
        const hit = mouseTarget(e.y - at.mainTop);
        return Boolean(hit?.target.drags?.({ ...e, y: hit.y }));
      }),
    [mouse],
  );

  // Layout: everything is sized to the terminal, one row short of it so Ink never clears the screen.
  const W = columns;
  const H = Math.max(12, rows - 1);
  // esc hides the activity lines; the Log view keeps them all.
  const act = activityRows(entries.filter((e) => e.shown !== false));
  const bottom = confirmReq ? confirmHeight(confirmReq) : 3 + suggestions.length;
  const mood = moodFor({ data, busy, lastEntry: entries.at(-1) });
  const reactionRows = reaction ? 1 : 0;
  // The welcome box only appears when the terminal has room for it next to a useful view.
  const showWelcome = welcome && H >= 28;
  const mainH = Math.max(6, H - 2 - reactionRows - act.length - (busy ? 1 : 0) - bottom - 1 - (showWelcome ? WELCOME_HEIGHT : 0));
  const viewActive = focus === 'view' && !overlay && !confirmReq;
  layout.current = {
    mainTop: 2,
    mainH,
    promptTop: 2 + mainH + (showWelcome ? WELCOME_HEIGHT : 0) + reactionRows + act.length + (busy ? 1 : 0),
    sugCount: suggestions.length,
    tabs: tabLabels(entries),
  };

  // The palette's list: this view's keys, yours, then the commands.
  const paletteList = useMemo(
    () => paletteItems({ commands: COMMANDS, user: custom.commands, sections: HELP.filter((s) => s.title === 'Anywhere' || s.views?.includes(view)), keymap: custom.keymap, view, skip: ['ctrl+p'] }),
    [custom, view],
  );

  let main;
  if (overlay?.kind === 'palette') {
    // Closed once every handler has had the esc, or App's would also take it (and clear the log).
    main = <Palette items={paletteList} query={overlay.query} ctx={ctx} width={W} height={mainH} active={focus === 'view' && !confirmReq} onPick={runPicked} onClose={() => queueMicrotask(ctx.closeOverlay)} />;
  } else if (overlay?.kind === 'help') {
    main = <HelpView sections={custom.sections} start={overlay.start} ctx={ctx} width={W} height={mainH} active={focus === 'view' && !confirmReq} onClose={ctx.closeOverlay} />;
  } else if (overlay?.kind === 'picker') {
    main = <Picker key={overlay.id} picker={overlay} ctx={ctx} width={W} height={mainH} active={focus === 'view' && !confirmReq} />;
  } else if (overlay) {
    main = <TextViewer {...overlay} ctx={ctx} width={W} height={mainH} active={focus === 'view' && !confirmReq} onClose={ctx.closeOverlay} />;
  } else if (view === 'log') {
    main = <LogView entries={entries} ctx={ctx} width={W} height={mainH} active={viewActive} />;
  } else if (!data) {
    main = (
      <Panel title={VIEWS.find((v) => v.id === view).label} width={W} height={mainH}>
        <Text color={theme.dim}>{loading ? '  Reading the subscription…' : "  Nothing read: the line below says why. r tries again."}</Text>
      </Panel>
    );
  } else if (view === 'logs') {
    main = <LogsView query={query} result={result} scope={resolved} ctx={ctx} width={W} height={mainH} active={viewActive} />;
  } else if (view === 'live') {
    main = <LiveView live={{ ...live, target: streamTarget }} ctx={ctx} width={W} height={mainH} active={viewActive} />;
  } else if (view === 'alerts') {
    main = <AlertsView alerts={alerts} scope={resolved} ctx={ctx} width={W} height={mainH} active={viewActive} />;
  } else if (view === 'problems') {
    main = <ProblemsView problems={problems} filter={problemFilter} scope={resolved} ctx={ctx} width={W} height={mainH} active={viewActive} />;
  } else {
    main = <ResourcesView data={data} extras={extras} span={TIMESPANS[spanIndex]} filter={filter} focusId={focusId} ctx={ctx} width={W} height={mainH} active={viewActive} />;
  }

  const left = flash
    ? flash.text
    : focus === 'prompt'
      ? 'enter run · tab complete · ↑↓ pick or history · esc back'
      : overlay?.kind === 'help'
        ? 'j/k section · space scroll · / search · esc close'
        : overlay?.kind === 'palette'
        ? 'type to filter · ↑↓ pick · ↵ run it (a key in the view; a command that takes more goes into the prompt) · esc close'
        : overlay?.kind === 'picker'
          ? overlay.hint
            ? `${overlay.hint} · esc close`
            : 'j/k move · ↵ change · esc close'
          : overlay
            ? `${overlay.hint && !overlay.loading ? `${overlay.hint} · ` : ''}j/k scroll · space page · y copy · esc close`
            : HINTS[view];
  const right = focus === 'prompt' ? '' : '  t span · / commands · , settings · ? help';

  return (
    <Box flexDirection="column" width={W} height={H}>
      <Header data={data} span={TIMESPANS[spanIndex]} demo={provider?.kind === 'demo'} width={W} loading={loading} mood={mood} />
      <Tabs view={view} entries={entries} width={W} />
      <Box height={mainH} width={W}>
        {main}
      </Box>
      {showWelcome ? <Welcome mood={mood} data={data} width={W} update={update} /> : null}
      {reaction ? (
        <Row
          pointer={false}
          width={W}
          segments={[
            { text: `${FACES[reaction.mood === 'happy' ? 'happy' : 'worried']} `, color: theme.accent, bold: true },
            { text: reactionLine(reaction), color: reaction.mood === 'happy' ? theme.add : theme.warn },
            { text: `  (${APP_NAMES[reaction.app] ?? reaction.app} · esc)`, color: theme.dim },
          ]}
        />
      ) : null}
      {act.map((segs, i) => (
        <Row key={i} pointer={false} width={W} segments={segs} />
      ))}
      {busy ? <Spinner label={busy.label} started={busy.started} width={W} /> : null}
      {confirmReq ? (
        confirmReq.secret ? (
          <SecretPrompt key={confirmReq.id} req={confirmReq} width={W} onDone={onConfirm} />
        ) : (
          <Confirm key={confirmReq.id} req={confirmReq} width={W} onDone={onConfirm} />
        )
      ) : (
        <PromptBox value={prompt.value} cursor={prompt.cursor} focused={focus === 'prompt'} width={W} placeholder="/ for commands (/kql, /sub, /find) · t time span · ? for shortcuts" />
      )}
      {suggestions.length ? <Suggestions items={suggestions} selected={sel} width={W} /> : null}
      <Row
        pointer={false}
        width={W}
        segments={[...fitSegments([{ text: `  ${left}`, color: theme.dim }], W - stringWidth(right)), { text: right, color: theme.dim }]}
      />
    </Box>
  );
}
