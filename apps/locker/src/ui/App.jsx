import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdin } from 'ink';
import * as a from '../actions.js';
import { COMMANDS, findCommand, suggestionsFor } from '../commands.js';
import { clearAfter, expiryDays, saveConfig } from '../config.js';
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
import { Confirm, PromptBox, Row, SecretPrompt, Spinner, Suggestions, confirmHeight } from '@fleet/kit/ui/parts.jsx';
import { HelpView } from '@fleet/kit/ui/HelpView.jsx';
import { DriftView } from './DriftView.jsx';
import { VaultView } from './VaultView.jsx';
import { ExpiryView } from './ExpiryView.jsx';
import { SourcesView } from './SourcesView.jsx';
import { LogView } from './LogView.jsx';
import { Viewer } from './Viewer.jsx';
import { Picker } from './Picker.jsx';
import { WELCOME_HEIGHT, Welcome } from './Pet.jsx';
import { FACES, moodFor, troubles } from '../pet.js';
import { decodeContext, logActivity, pastedLine, readMoods, writeMood } from '@fleet/kit/family.js';
import { familyMood, reactionTo } from '../moods.js';
import { label } from '../azure/arm.js';
import { azProblem } from '../azure/az.js';
import { basename } from 'node:path';
import { remember } from '@fleet/kit/folders.js';
import { driftColumns, pickTarget, loadSubscription, loadTarget, loadVault, referencedVaults, vaultMap } from '../load.js';
import { driftMatrix } from '../drift.js';
import { expiring, expiryNotice } from '../expiry.js';
import { createLocal } from '../local.js';

const VIEWS = [
  { id: 'drift', label: 'Drift' },
  { id: 'vault', label: 'Vault' },
  { id: 'expiry', label: 'Expiry' },
  { id: 'sources', label: 'Sources' },
  { id: 'log', label: 'Log' },
];
const VIEW_LABELS = Object.fromEntries(VIEWS.map((v) => [v.id, v.label]));

const HINTS = {
  drift: '↵ where · v values · y copy · a add to .env · d differs · m missing · c columns · t Sonar',
  vault: '↵ details · v value · y copy · e new value · n new secret · x disable',
  expiry: '↵ details · e new value',
  sources: '↵ its keys · space column or not',
  log: '↵ all its output · y copy it',
};

const helpSections = (user, keymap) => [...HELP, ...[keymapSection(keymap, VIEW_LABELS)].filter(Boolean), commandsSection([...COMMANDS, ...user])];
// ctrl+p, as the terminal sends it: the command palette.
const CTRL_P = '\x10';
const DOUBLE_CLICK_MS = 400;
const firstLine = (s) => String(s ?? '').split('\n')[0];
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function Header({ data, width, loading, mood, problem, demo }) {
  const segs = [
    { text: `${FACES[mood]} `, color: theme.accent, bold: true },
    { text: 'Locker', bold: true },
  ];
  if (demo) segs.push({ text: '  demo', color: theme.warn });
  if (data.dir) segs.push({ text: '  │  ', color: theme.border }, { text: basename(data.dir), bold: true });
  segs.push({ text: '  │  ', color: theme.border }, { text: data.target ? label(data.target) : 'no app', color: data.target ? theme.info : theme.dim });
  segs.push({ text: ' · ', color: theme.border }, { text: data.vault ? data.vault.name : 'no vault', color: data.vault ? theme.accent : theme.dim });
  if (data.trouble.expiring.length) segs.push({ text: `  ${data.trouble.expiring.length} expiring`, color: theme.del, bold: true });
  if (data.trouble.broken.length) segs.push({ text: `  ${data.trouble.broken.length} broken`, color: theme.del, bold: true });
  if (data.trouble.drift.length) segs.push({ text: `  ${data.trouble.drift.length} differ`, color: theme.warn });
  if (loading) segs.push({ text: '  reading…', color: theme.dim });
  if (problem) segs.push({ text: '  │  ', color: theme.border }, { text: firstLine(problem), color: theme.warn });
  return <Row pointer={false} width={width} segments={segs} />;
}

/** The tabs' labels and the columns each one covers (`from` up to `to`), which clicks are matched against. */
function tabLabels(entries, counts) {
  let x = 0;
  return VIEWS.map((v, i) => {
    let text = ` ${i + 1} ${v.label}`;
    if (v.id === 'log' && entries.length) text += ` ${entries.length}`;
    if (v.id === 'expiry' && counts.expiring) text += ` ${counts.expiring}`;
    text += ' ';
    const from = x;
    x += stringWidth(text) + 1;
    return { id: v.id, label: text, from, to: from + stringWidth(text) };
  });
}

function Tabs({ view, entries, counts, width }) {
  const segs = [];
  for (const t of tabLabels(entries, counts)) {
    const on = t.id === view;
    segs.push({ text: t.label, bg: on ? theme.accent : undefined, color: on ? theme.ink : t.id === 'expiry' && counts.expiring ? theme.del : theme.dim, bold: on }, { text: ' ' });
  }
  return <Row pointer={false} width={width} segments={segs} />;
}

// The last two results, Claude Code style: "● Set Stripe--ApiKey" then "  ⎿  output".
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

// A viewer of its own for each thing shown, so going back from one to another doesn't keep where the first was scrolled to.
const viewerKeys = new WeakMap();
let viewerCount = 0;
const viewerKey = (overlay) => {
  if (!viewerKeys.has(overlay)) viewerKeys.set(overlay, ++viewerCount);
  return viewerKeys.get(overlay);
};

const EMPTY = { local: [], azure: null, azureProblem: null, target: null, app: null, appProblem: null, vault: null, vaults: new Map() };

/** Everything the views draw, worked out from what was read and the settings: the columns, the matrix, what's wrong. */
function derive(store, config) {
  const vaultData = store.vault ? store.vaults.get(store.vault.name) ?? null : null;
  const columns = driftColumns({ local: store.local, choices: config.columns ?? {}, target: store.target, app: store.app, vault: store.vault, vaultData: vaultData?.secrets ? vaultData : null });
  const matrix = driftMatrix(columns, { vaults: vaultMap(store.vaults) });
  const days = expiryDays(config);
  const soon = [];
  for (const [name, d] of store.vaults) {
    const v = store.azure?.vaults?.find((x) => x.name === name) ?? { name };
    for (const s of expiring([...(d.secrets ?? []), ...(d.certificates ?? [])], { days })) soon.push({ vault: v, s });
  }
  soon.sort((x, y) => Date.parse(x.s.expires) - Date.parse(y.s.expires));
  const trouble = troubles({ vaultData, matrix, days });
  // Every vault's, not just the one picked: a referenced vault running out is as worrying.
  trouble.expiring = soon.filter((x) => x.s.enabled !== false).map((x) => x.s);
  return { ...store, vaultData, columns, matrix, expiringItems: soon, trouble };
}

// `provider` is azure/arm.js's (demo.js's for --demo and the tests), `local` local.js's createLocal (demoLocal).
// `guard` is clipguard.js's, which copies a value and clears it again; `copy` puts plain text on the clipboard.
// `notify` raises the terminal's notification (an expiry on start), `openUrl` opens the browser. `checkUpdate`
// and `installUpdate` come only in the downloaded builds, so tests and checkouts never go online or replace anything.
// `onConfig` hears every change of the settings (cli.jsx's guard reads clearClipboard from them).
// `makeLocal(dir)` reads another folder (/move): createLocal's, null in the demo, which has one folder.
export function App({ config: initialConfig, provider, local = createLocal(), makeLocal: readerFor, cwd, guard, copy, notify, openUrl, setTitle, mouse, checkUpdate, installUpdate, onConfig, moodEvery = 30_000, demo = false }) {
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize();
  const [config, setConfigState] = useState(initialConfig);
  const [store, setStoreState] = useState(() => ({ ...EMPTY, dir: cwd ?? local.dir }));
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState('drift');
  const [filter, setFilterState] = useState('all');
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
  // A word in the bottom line for a moment ("Copied db-password"), where it moves nothing on screen.
  const [flash, setFlash] = useState(null);
  const nothingToCopy = () => setFlash({ text: 'Drag over text to copy it · q quits' });
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 3000);
    return () => clearTimeout(t);
  }, [flash]);

  // A sibling's mood Hush reacts to (family.js's readMoods, every `moodEvery` ms): one line until esc.
  const [reaction, setReaction] = useState(null);
  const reactionRef = useRef(null);
  reactionRef.current = reaction;
  const seenMoods = useRef(new Set());
  useEffect(() => {
    if (config.familyMoods === false || !moodEvery) return setReaction(null);
    const look = () => {
      const r = reactionTo(readMoods('locker'), seenMoods.current);
      if (!r) return;
      seenMoods.current.add(r.key);
      setReaction(r);
    };
    look();
    const t = setInterval(look, moodEvery);
    return () => clearInterval(t);
  }, [config.familyMoods, moodEvery]);

  // Your own commands and keys (the config's "commands" and "keys"), and what was wrong with them.
  const custom = useMemo(() => {
    const mine = userCommands(config.commands, COMMANDS.map((c) => c.name));
    const commands = mine.commands.map((c) => ({ ...c, run: (_, rest) => runUserCommand(c, rest) }));
    const keymap = parseKeymap(config.keys, VIEWS.map((v) => v.id));
    return { commands, keymap, sections: helpSections(commands, keymap), problems: [...mine.problems.map((p) => `commands: ${p}`), ...keymap.problems.map((p) => `keys: ${p}`)] };
  }, [config.commands, config.keys]);
  const customRef = useRef(custom);
  customRef.current = custom;
  // A key picked in the palette, sent to the view once it's back on screen (the effect below).
  const pendingKey = useRef(null);

  // Async actions read the latest state through refs, not through stale closures.
  // The folder read (/move changes it): its local.js reader, and `store.dir`.
  const localRef = useRef(local);
  const makeLocal = readerFor !== undefined ? readerFor : demo ? null : (dir) => createLocal({ dir });
  const storeRef = useRef({ ...EMPTY, dir: cwd ?? local.dir });
  const busyRef = useRef(null);
  const configRef = useRef(config);
  const promptRef = useRef(prompt);
  const confirmRef = useRef(null);
  const focusRef = useRef('view');
  const overlayRef = useRef(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const nextId = useRef(1);
  const cursors = useRef({});
  const historyPos = useRef(-1);
  const lastOutput = useRef(null);
  // Errors said and questions answered no, counted so a line of your own command knows it failed.
  const errorCount = useRef(0);
  const declines = useRef(0);
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

  const updateStore = (patch) => {
    storeRef.current = { ...storeRef.current, ...(typeof patch === 'function' ? patch(storeRef.current) : patch) };
    setStoreState(storeRef.current);
  };
  const setConfig = (next) => {
    const value = typeof next === 'function' ? next(configRef.current) : next;
    configRef.current = value;
    setConfigState(value);
    saveConfig(value);
    onConfig?.(value);
  };
  const setFocus = (f) => {
    focusRef.current = f;
    setFocusState(f);
  };
  const setOverlay = (next) => {
    overlayRef.current = typeof next === 'function' ? next(overlayRef.current) : next;
    setOverlayState(overlayRef.current);
  };
  const setPrompt = (value, cursor = value.length) => {
    promptRef.current = { value, cursor };
    setPromptState(promptRef.current);
  };
  const filterRef = useRef('all');
  const setFilter = (f) => {
    if (!['all', 'diff', 'missing'].includes(f)) return note('/only all, diff or missing.', 'error') ?? false;
    filterRef.current = f;
    setFilterState(f);
    setView('drift');
    return true;
  };

  const addEntry = (e) => {
    const id = nextId.current++;
    setEntries((list) => [...list.slice(-99), { id, lines: [], at: Date.now(), ...e }]);
    return id;
  };
  const updateEntry = (id, patch) => setEntries((list) => list.map((e) => (e.id === id ? { ...e, at: Date.now(), ...patch } : e)));
  const note = (text, status = 'info') => {
    if (status === 'error') errorCount.current++;
    const [title, ...lines] = String(text).split('\n');
    addEntry({ title, status, lines });
  };

  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  // What is read, each part on its own so one failing leaves the rest: the folder, the subscription's
  // apps and vaults, the app's settings, a vault's secrets.
  const readLocal = async () => {
    try {
      const reader = localRef.current;
      const sources = await reader.sources();
      if (alive.current && localRef.current === reader) updateStore({ local: sources });
    } catch (e) {
      if (alive.current) note(`Couldn't read ${localRef.current.dir}: ${firstLine(e.message)}`, 'error');
    }
  };
  // /move: another folder's settings read in this one's place, remembered for the picker; the app
  // named as the folder (or the only one) is compared when there is one.
  const moveTo = async (dir) => {
    if (!makeLocal) return note('The demo has one folder: start Locker in a project to move between folders.');
    localRef.current = makeLocal(dir);
    updateStore({ dir, local: [] });
    setConfig((c) => ({ ...c, projects: remember(c.projects, dir) }));
    note(`Reading ${dir}`);
    await readLocal();
    const site = pickTarget(storeRef.current.azure?.sites ?? [], { dir });
    if (site && site.id !== storeRef.current.target?.id) await chooseTarget(site);
  };
  const readVault = async (name) => {
    const v = storeRef.current.azure?.vaults?.find((x) => x.name.toLowerCase() === String(name).toLowerCase());
    if (!v) return;
    try {
      const d = await loadVault(provider, v);
      if (alive.current) updateStore((s) => ({ vaults: new Map(s.vaults).set(v.name, d) }));
    } catch (e) {
      if (alive.current) updateStore((s) => ({ vaults: new Map(s.vaults).set(v.name, { problem: firstLine(e.message) }) }));
    }
  };
  const readTarget = async () => {
    const target = storeRef.current.target;
    if (!target) return;
    try {
      const app = await loadTarget(provider, target);
      if (!alive.current || storeRef.current.target?.id !== target.id) return;
      updateStore({ app, appProblem: null });
      // The vaults its references name, so they can be checked (and the picked one, if none was).
      const names = referencedVaults(app);
      const known = storeRef.current.azure?.vaults ?? [];
      if (!storeRef.current.vault) {
        const v = known.find((x) => names.includes(x.name.toLowerCase()));
        if (v) chooseVault(v, { quiet: true });
      }
      await Promise.all(names.filter((n) => !storeRef.current.vaults.has(known.find((x) => x.name.toLowerCase() === n)?.name)).map((n) => readVault(n)));
    } catch (e) {
      if (alive.current) updateStore({ appProblem: firstLine(e.message) });
    }
  };
  const readAzure = async () => {
    try {
      const azure = await loadSubscription(provider, { saved: configRef.current.subscription });
      if (!alive.current) return;
      const saved = configRef.current;
      const target = pickTarget(azure.sites, { saved: saved.target, dir: ctx.cwd() });
      const vault = azure.vaults.find((v) => v.name === saved.vault) ?? (azure.vaults.length === 1 ? azure.vaults[0] : null);
      updateStore({ azure, azureProblem: null, target, app: null, vault, vaults: new Map() });
      await Promise.all([readTarget(), vault ? readVault(vault.name) : null]);
    } catch (e) {
      if (alive.current) updateStore({ azureProblem: azProblem(e.message) ?? firstLine(e.message) });
    }
  };
  const readAll = async () => {
    setLoading(true);
    await Promise.all([readLocal(), readAzure()]);
    if (alive.current) setLoading(false);
  };

  const chooseTarget = async (site) => {
    updateStore({ target: site, app: null, appProblem: null });
    setConfig((c) => {
      const next = { ...c };
      if (site) next.target = { id: site.id, label: label(site) };
      else delete next.target;
      return next;
    });
    if (!site) return note('No app: the drift view compares the folder and the vault.');
    note(`Comparing ${label(site)}'s settings`);
    await readTarget();
    return true;
  };
  const chooseVault = async (v, { quiet = false } = {}) => {
    updateStore({ vault: v });
    setConfig((c) => {
      const next = { ...c };
      if (v) next.vault = v.name;
      else delete next.vault;
      return next;
    });
    if (!v) return note('No key vault.');
    if (!quiet) note(`Looking at ${v.name}`);
    if (!storeRef.current.vaults.get(v.name)?.secrets) await readVault(v.name);
    return true;
  };
  const chooseSubscription = async (sub) => {
    setConfig((c) => ({ ...c, subscription: sub.id }));
    note(`Reading ${sub.name}`);
    setLoading(true);
    await readAzure();
    if (alive.current) setLoading(false);
    return true;
  };

  const task = async (title, start, { label: what = 'Working', activity, kind = 'change', project, reload } = {}) => {
    if (busyRef.current) {
      note(`Wait for "${busyRef.current.label}" to finish (esc cancels it).`, 'error');
      return { ok: false, error: new Error('busy') };
    }
    const controller = new AbortController();
    const b = { label: what, started: Date.now(), abort: () => controller.abort() };
    busyRef.current = b;
    setBusy(b);
    const id = addEntry({ title, status: 'running' });
    setWelcome(false);
    try {
      const result = await start(controller.signal);
      const { stdout = '', stderr = '' } = result ?? {};
      const out = [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join('\n');
      lastOutput.current = { title, text: out || '(no output)' };
      updateEntry(id, { status: 'ok', lines: out ? out.split('\n') : ['Done'] });
      // What changed something (or put a value on the clipboard) goes in the family's activity log: what, never the value.
      if (activity && configRef.current.familyMoods !== false) logActivity('locker', { text: activity, kind, project });
      return { ok: true, out, result };
    } catch (error) {
      errorCount.current++;
      lastOutput.current = { title, text: error.message };
      updateEntry(id, { status: 'error', lines: error.cancelled ? ['Cancelled'] : error.message.split('\n') });
      return { ok: false, error };
    } finally {
      busyRef.current = null;
      setBusy(null);
      if (reload?.local) await readLocal();
      if (reload?.vault) await readVault(reload.vault);
    }
  };

  const confirm = (req) =>
    new Promise((done) => {
      const full = {
        options: [
          { label: 'Yes', value: true },
          { label: 'No', value: false },
        ],
        ...req,
        id: nextId.current++,
        done: (v) => {
          if (v === false || v == null) declines.current++;
          done(v);
        },
      };
      confirmRef.current = full;
      setConfirmReq(full);
    });
  const onConfirm = (value) => {
    const req = confirmRef.current;
    confirmRef.current = null;
    answerKey.current = keySeq.current;
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

  // ctx.data, worked out again only when what it's made from has changed.
  const derived = useRef({ store: null, config: null, value: null });
  const dataNow = () => {
    const d = derived.current;
    if (d.store !== storeRef.current || d.config !== configRef.current) derived.current = { store: storeRef.current, config: configRef.current, value: derive(storeRef.current, configRef.current) };
    return derived.current.value;
  };

  const ctxRef = useRef(null);
  if (!ctxRef.current) ctxRef.current = { get data() { return dataNow(); }, get config() { return configRef.current; }, mouseHandlers: [] };
  const ctx = ctxRef.current;
  Object.assign(ctx, {
    provider,
    local: localRef.current,
    moveTo,
    task,
    note,
    confirm,
    // A plain or masked field in the confirm's place: resolves the text (or null on esc).
    askText: async (req) => (await confirm({ ...req, secret: true, plain: true, options: [] }))?.value ?? null,
    askSecret: async (req) => (await confirm({ ...req, secret: true, options: [] }))?.value ?? null,
    prefill,
    cwd: () => storeRef.current.dir ?? process.cwd(),
    refresh: () => readAll(),
    setConfig,
    setView,
    setFilter,
    chooseTarget,
    chooseVault,
    chooseSubscription,
    findSecret: (name) => {
      const n = String(name ?? '').trim().toLowerCase();
      const s = dataNow().vaultData?.secrets?.find((x) => x.name.toLowerCase() === n);
      if (!s) note(n ? `No secret ${name.trim()} in ${dataNow().vault?.name ?? 'the vault'}.` : 'Name a secret.', 'error');
      return s ?? null;
    },
    openUrl: (url) => (openUrl ? openUrl(url) : note(`Open ${url}`)),
    // Where a view's cursor was (`key` read back), or with `at` where it is now: so it is still there after an overlay.
    cursor: (key, ...at) => (at.length ? (cursors.current[key] = at[0]) : cursors.current[key]),
    // /update: asks for the latest release now, whatever the daily check last said, and installs it.
    updateNow: () => {
      if (askHostToUpdate()) return note('Asked Fleet to look for a new version of the whole fleet.');
      if (!checkUpdate) return note(`This Locker (${VERSION}) runs from a checkout: git pull updates it.`);
      if (update?.state === 'installing') return note(`Locker ${update.latest} is being installed already.`);
      if (update?.state === 'installed') return note(`Locker ${update.latest} is installed. It starts the next time you open Locker.`);
      const said = (text) => ({ stdout: text, stderr: '' });
      return task(
        'Looking for a new version of Locker',
        async () => {
          const { checked, newer } = await checkUpdate(null);
          setConfig((c) => ({ ...c, lastUpdateCheck: checked }));
          if (!newer) return said(`Locker ${VERSION} is the latest version.`);
          if (!installUpdate) {
            setUpdate({ ...checked, state: 'out' });
            return said(`Locker ${checked.latest} is out (you have ${VERSION}). Download it from ${checked.url}`);
          }
          setUpdate({ ...checked, state: 'installing' });
          try {
            await installUpdate(checked.latest);
          } catch (e) {
            setUpdate({ ...checked, state: 'out' });
            throw new Error(`Locker ${checked.latest} is out, but it couldn't be installed: ${firstLine(e.message)}\nDownload it from ${checked.url}`);
          }
          setUpdate({ ...checked, state: 'installed' });
          return said(`Locker ${checked.latest} is installed. It starts the next time you open Locker.`);
        },
        { label: 'Updating Locker' },
      );
    },
    // Text that isn't secret to the clipboard (a line for a sibling), said in the bottom line as "Copied <what>".
    copy: (text, what = text) => {
      if (!copy) return note("Copying to the clipboard isn't available here.", 'error');
      copy(text);
      setFlash({ text: `Copied ${what}` });
    },
    // A value to the clipboard, cleared again after the clearClipboard setting's seconds.
    copySecret: (value, what) => {
      if (!guard) return note("Copying to the clipboard isn't available here.", 'error');
      guard.put(value);
      const secs = clearAfter(configRef.current);
      setFlash({ text: `Copied ${what}${secs ? ` · cleared in ${secs} s` : ''}` });
    },
    // Views call this first in their key handlers, for the same reason as the dispatcher below.
    viewHasKeys: () => focusRef.current === 'view' && !overlayRef.current && !confirmRef.current && answerKey.current !== keySeq.current,
    overlayHasKeys: () => focusRef.current === 'view' && !confirmRef.current && answerKey.current !== keySeq.current,
    quit: () => exit(),
    // A value shown (`secret`) is kept only by the overlay, so closing it forgets it; /last never has it.
    showText: (title, text, opts = {}) => setOverlay({ title, text, ...opts }),
    showPicker: (picker) => setOverlay({ kind: 'picker', picker }),
    // A picker whose items are a function draws them again (the columns, after one is turned on or off).
    refreshPicker: () => setOverlay((o) => (o?.kind === 'picker' ? { ...o, picker: { ...o.picker } } : o)),
    closeOverlay: () => setOverlay(null),
    showHelp: () => setOverlay({ kind: 'help', start: sectionFor(customRef.current.sections, viewRef.current) }),
    openPalette: () => openPalette(),
    runLine: (text) => runLine(text),
    showLast: () => (lastOutput.current ? setOverlay({ ...lastOutput.current }) : note('No command has run yet.')),
  });

  // One line as typed at the prompt: a shell command after !, else a slash command. Resolves false
  // when it failed: it threw, said an error, or a question it asked was answered no (so your own
  // commands stop there).
  const runLine = async (text) => {
    const [errors, declined] = [errorCount.current, declines.current];
    try {
      let r;
      if (text.startsWith('!')) r = await a.raw(ctx, text.slice(1).trim());
      // A sibling's context pasted alone is /take's.
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

  // Read everything on opening; then say what runs out soon (once), and look for a newer release.
  const told = useRef(false);
  useEffect(() => {
    // The folder Locker opened in, first in /move's list.
    if (makeLocal) setConfig((c) => ({ ...c, projects: remember(c.projects, storeRef.current.dir) }));
    (async () => {
      await readAll();
      if (!alive.current) return;
      if (custom.problems.length) note(`Your settings file has ${plural(custom.problems.length, 'problem')}:\n${custom.problems.join('\n')}`, 'error');
      const d = dataNow();
      if (!told.current && d.expiringItems.length) {
        told.current = true;
        const byVault = d.vault ? d.expiringItems.filter((x) => x.vault.name === d.vault.name) : d.expiringItems;
        const list = (byVault.length ? byVault : d.expiringItems).map((x) => x.s);
        const said = expiryNotice(list, { vault: byVault.length ? d.vault?.name : undefined, days: expiryDays(configRef.current) });
        note(`${said}\n3 lists them.`, 'error');
        if (configRef.current.notify !== false) notify?.('Locker', said);
      }
      if (checkUpdate && configRef.current.checkForUpdates !== false) {
        checkUpdate(configRef.current.lastUpdateCheck).then(
          ({ checked, newer }) => {
            setConfig((c) => ({ ...c, lastUpdateCheck: checked }));
            if (!newer) return;
            const outNote = (why = '') => note(`Locker ${checked.latest} is out (you have ${VERSION})${why}.\nDownload it from ${checked.url}`);
            if (!installUpdate || configRef.current.autoUpdate === false) {
              setUpdate({ ...checked, state: 'out' });
              return outNote();
            }
            // In the background, without the spinner: nothing waits on it, and it only counts from the next start.
            setUpdate({ ...checked, state: 'installing' });
            installUpdate(checked.latest).then(
              () => {
                setUpdate({ ...checked, state: 'installed' });
                note(`Locker ${checked.latest} is installed. It starts the next time you open Locker.`);
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
  const title = `${VIEW_LABELS[view]} — Locker`;
  useEffect(() => {
    setTitle?.(title);
  }, [title]);

  const data = useMemo(() => dataNow(), [store, config]);
  const suggestions = focus === 'prompt' && !confirmReq ? suggestionsFor(prompt.value, { data, user: custom.commands }) : [];
  const sel = Math.min(sugIndex, Math.max(0, suggestions.length - 1));

  // Your keys, where they come in: while a view has the keys (never while typing, in a confirm or
  // over an overlay), a key you mapped becomes the key it stands for, or runs its command line.
  // Uppercase shortcuts are alt+letter (caps lock can't fire them). Then ctrl+p opens the palette.
  const sendKey = useKeyTranslation((input) => {
    let out = input;
    if (focusRef.current === 'view' && !overlayRef.current && !confirmRef.current) {
      const b = translateKey(customRef.current.keymap, viewRef.current, input);
      if (b?.command) {
        queueMicrotask(() => runLine(b.command));
        return null;
      }
      if (b?.key) out = b.key.seq;
    }
    if (out === input && focusRef.current === 'view' && !confirmRef.current && !['palette', 'help'].includes(overlayRef.current?.kind)) out = shortcutKey(input);
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

  // Line editing in the prompt.
  const promptKeys = (input, key) => {
    const { value, cursor } = promptRef.current;
    const items = suggestionsFor(value, { data: dataNow(), user: customRef.current.commands });
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
      else if (reactionRef.current) setReaction(null);
      else {
        setEntries((list) => list.map((e) => ({ ...e, shown: false })));
        setWelcome(false);
      }
      return;
    }
    if (key.ctrl && input === 'r') return readAll();
    // A paste of a command line (or a sibling's family:v1: context) opens the prompt with it, to run with enter.
    const pasted = pastedLine(input);
    if (pasted) return prefill(pasted);
    if (input === '/' || input === ':') return prefill('/');
    if (input === '!') return prefill('!');
    if (input === '?') return ctx.showHelp();
    if (input === ',') return a.settings(ctx);
    if (input === 'q') return exit();
    const n = Number(input);
    if (n >= 1 && n <= VIEWS.length) return setView(VIEWS[n - 1].id);
    if (key.tab) {
      const i = VIEWS.findIndex((v) => v.id === viewRef.current);
      return setView(VIEWS[(i + (key.shift ? VIEWS.length - 1 : 1)) % VIEWS.length].id);
    }
  };

  // One dispatcher reading focus from refs, which change the instant focus moves. Handlers that
  // switch on with the next render would let fast typing (or a paste) after "/" leak into the view.
  useInput((input, key) => {
    if (focusRef.current === 'prompt' && !confirmRef.current) return prefillKey.current === keySeq.current ? undefined : promptKeys(input, key);
    if (key.ctrl && input === 'c') return nothingToCopy();
    if (confirmRef.current || overlayRef.current || answerKey.current === keySeq.current) return;
    globalKeys(input, key);
  });

  // The terminal reports the mouse while the setting is on (it is unless set off).
  useEffect(() => {
    mouse?.enable(config.mouse !== false);
  }, [config.mouse]);

  // Where things were drawn, for matching clicks against (set as the layout below is worked out).
  const layout = useRef(null);
  const lastPress = useRef(null);
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
      lastPress.current = count < 3 ? { x: e.x, y: e.y, at: now, count } : null;
    } else if (!e.drag && e.button !== 'wheel') return;
    if (confirmRef.current || !layout.current) return;
    const { mainTop, mainH, promptTop, sugCount, tabs } = layout.current;
    if (e.drag) {
      const hit = mouseTarget(e.from.y - mainTop);
      if (!hit) return;
      if (focusRef.current === 'prompt') setFocus('view');
      return hit.target.handle({ ...e, y: e.y - mainTop - hit.target.top, from: { x: e.from.x, y: hit.y } });
    }
    if (e.y === mainTop - 1 && !e.wheel) {
      const tab = tabs.find((t) => e.x >= t.from && e.x < t.to);
      if (!tab) return;
      if (overlayRef.current) ctx.closeOverlay();
      setFocus('view');
      return setView(tab.id);
    }
    if (e.y >= mainTop && e.y < mainTop + mainH) {
      if (!e.wheel && focusRef.current === 'prompt') setFocus('view');
      const hit = mouseTarget(e.y - mainTop);
      return hit?.target.handle({ ...e, y: hit.y });
    }
    if (e.wheel) return;
    if (e.y >= promptTop && e.y < promptTop + 3) {
      const { value, cursor } = promptRef.current;
      const inner = columns - 6;
      const start = focusRef.current === 'prompt' ? Math.max(0, cursor - inner + 1) : 0;
      setPrompt(value, Math.max(0, Math.min(value.length, start + e.x - 4)));
      return setFocus('prompt');
    }
    const row = e.y - promptTop - 3;
    if (row >= 0 && row < sugCount) {
      setSugIndex(row);
      if (e.double) promptKeys('', { return: true });
    }
  };
  const mouseRef = useRef(onMouse);
  mouseRef.current = onMouse;
  useEffect(() => mouse?.subscribe((e) => mouseRef.current(e)), [mouse]);
  useEffect(() => mouse?.claimDrags?.(() => false), [mouse]);

  // Layout: everything is sized to the terminal, one row short of it so Ink never clears the screen.
  const W = columns;
  const H = Math.max(12, rows - 1);
  const act = activityRows(entries.filter((e) => e.shown !== false));
  const bottom = confirmReq ? confirmHeight(confirmReq) : 3 + suggestions.length;
  const loaded = !loading;
  const mood = moodFor({ loaded, busy, lastEntry: entries.at(-1), trouble: data.trouble });
  // How Hush feels, for the siblings (family.js's writeMood), whenever that changes.
  const said = familyMood({ mood, trouble: loaded ? data.trouble : null, lastEntry: entries.at(-1), busy });
  useEffect(() => {
    if (config.familyMoods !== false) writeMood('locker', said);
  }, [said.mood, said.reason, config.familyMoods]);
  const showWelcome = welcome && H >= 28;
  const reacting = reaction ? 1 : 0;
  const mainH = Math.max(6, H - 2 - reacting - act.length - (busy ? 1 : 0) - bottom - 1 - (showWelcome ? WELCOME_HEIGHT : 0));
  const viewActive = focus === 'view' && !overlay && !confirmReq;
  const counts = { expiring: data.expiringItems.length };
  layout.current = {
    mainTop: 2,
    mainH,
    promptTop: 2 + mainH + (showWelcome ? WELCOME_HEIGHT : 0) + reacting + act.length + (busy ? 1 : 0),
    sugCount: suggestions.length,
    tabs: tabLabels(entries, counts),
  };

  // The palette's list: this view's keys, yours, then the commands.
  const paletteList = useMemo(
    () => paletteItems({ commands: COMMANDS, user: custom.commands, sections: HELP.filter((s) => s.title === 'Anywhere' || s.views?.includes(view)), keymap: custom.keymap, view, skip: ['ctrl+p'] }),
    [custom, view],
  );

  const overlayActive = focus === 'view' && !confirmReq;
  let main;
  if (overlay?.kind === 'help') {
    main = <HelpView sections={custom.sections} start={overlay.start} ctx={ctx} width={W} height={mainH} active={overlayActive} onClose={() => queueMicrotask(ctx.closeOverlay)} />;
  } else if (overlay?.kind === 'palette') {
    main = <Palette items={paletteList} query={overlay.query} ctx={ctx} width={W} height={mainH} active={overlayActive} onPick={runPicked} onClose={() => queueMicrotask(ctx.closeOverlay)} />;
  } else if (overlay?.kind === 'picker') {
    main = <Picker key={viewerKey(overlay)} picker={overlay.picker} ctx={ctx} width={W} height={mainH} active={overlayActive} />;
  } else if (overlay) {
    main = <Viewer key={viewerKey(overlay)} title={overlay.title} text={overlay.text} lines={overlay.lines} secret={overlay.secret} onKey={overlay.onKey} ctx={ctx} width={W} height={mainH} active={overlayActive} onClose={() => queueMicrotask(ctx.closeOverlay)} />;
  } else if (view === 'log') {
    main = <LogView entries={entries} ctx={ctx} width={W} height={mainH} active={viewActive} />;
  } else if (view === 'vault') {
    main = <VaultView vault={data.vault} data={data.vaultData?.secrets ? data.vaultData : null} problem={data.vaultData?.problem ?? (data.vault ? null : data.azureProblem)} ctx={ctx} width={W} height={mainH} active={viewActive} />;
  } else if (view === 'expiry') {
    main = <ExpiryView items={data.expiringItems} ctx={ctx} width={W} height={mainH} active={viewActive} loading={loading} />;
  } else if (view === 'sources') {
    main = <SourcesView data={data} ctx={ctx} width={W} height={mainH} active={viewActive} />;
  } else {
    main = <DriftView matrix={data.matrix} filter={filter} ctx={ctx} width={W} height={mainH} active={viewActive} loading={loading} />;
  }

  const left = flash
    ? flash.text
    : focus === 'prompt'
      ? 'enter run · tab complete · ↑↓ pick or history · esc back'
      : overlay?.kind === 'help'
        ? 'j/k section · space scroll · / search · esc close'
        : overlay?.kind === 'palette' || overlay?.kind === 'picker'
          ? '↑↓ pick · ↵ run it · esc close'
          : overlay
            ? 'j/k scroll · space page · y copy · esc close'
            : HINTS[view];
  const right = focus === 'prompt' ? '' : '  / commands · ctrl+p palette · ? help';
  const problem = data.azureProblem ?? data.appProblem;

  return (
    <Box flexDirection="column" width={W} height={H}>
      <Header data={data} width={W} loading={loading} mood={mood} problem={problem} demo={demo} />
      <Tabs view={view} entries={entries} counts={counts} width={W} />
      <Box height={mainH} width={W}>
        {main}
      </Box>
      {showWelcome ? <Welcome mood={mood} info={{ loaded, trouble: data.trouble, target: data.target, vault: data.vault }} width={W} update={update} /> : null}
      {reaction ? (
        <Row
          pointer={false}
          width={W}
          segments={[
            { text: `${FACES[reaction.mood === 'happy' ? 'happy' : 'worried']} `, color: theme.accent, bold: true },
            { text: reaction.text },
            { text: '  esc', color: theme.dim },
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
        <PromptBox value={prompt.value} cursor={prompt.cursor} focused={focus === 'prompt'} width={W} placeholder="Press / for commands, ! to run a shell command, ? for shortcuts" />
      )}
      {suggestions.length ? <Suggestions items={suggestions} selected={sel} width={W} /> : null}
      <Row pointer={false} width={W} segments={[...fitSegments([{ text: `  ${left}`, color: theme.dim }], W - stringWidth(right)), { text: right, color: theme.dim }]} />
    </Box>
  );
}
