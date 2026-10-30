import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, useApp, useInput, useStdin } from 'ink';
import * as a from '../actions.js';
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
import { Confirm, PromptBox, Row, SecretPrompt, Spinner, Suggestions, confirmHeight } from '@fleet/kit/ui/parts.jsx';
import { HelpView } from '@fleet/kit/ui/HelpView.jsx';
import { logActivity, pastedLine, readMoods, writeMood } from '@fleet/kit/family.js';
import { FACES, moodFor, troubles } from '../pet.js';
import { familyMood, reactionTo } from '../moods.js';
import { shellQuote } from '../sftp.js';
import { hostText } from '../hosts.js';
import { SessionError } from '../errors.js';
import { createQueue } from '../queue.js';
import { FilesView } from './FilesView.jsx';
import { TransfersView } from './TransfersView.jsx';
import { HostsView } from './HostsView.jsx';
import { LogView } from './LogView.jsx';
import { Viewer } from './Viewer.jsx';
import { Picker } from './Picker.jsx';
import { ConsoleView } from './ConsoleView.jsx';
import { WELCOME_HEIGHT, Welcome } from './Pet.jsx';

const VIEWS = [
  { id: 'files', label: 'Files' },
  { id: 'transfers', label: 'Transfers' },
  { id: 'console', label: 'Console' },
  { id: 'hosts', label: 'Hosts' },
  { id: 'log', label: 'Log' },
];
const VIEW_LABELS = Object.fromEntries(VIEWS.map((v) => [v.id, v.label]));

const HINTS = {
  files: '← → pane · ↵ open · space mark · c copy over · m mkdir · r rename · d delete · . hidden',
  transfers: '↵ details · x cancel · r retry · d remove · c clear done',
  console: '↵ or $ type a command · x cancel · c clear · y copy its output',
  hosts: '↵ connect · a add · e change · x forget',
  log: '↵ all its output · y copy it',
};

const helpSections = (user, keymap) => [...HELP, ...[keymapSection(keymap, VIEW_LABELS)].filter(Boolean), commandsSection([...COMMANDS, ...user])];
// ctrl+p, as the terminal sends it: the command palette.
const CTRL_P = '\x10';
const DOUBLE_CLICK_MS = 400;
const firstLine = (s) => String(s ?? '').split('\n')[0];
/** `promise`, or a rejection when `signal` aborts first. */
const abortable = (promise, signal) =>
  Promise.race([promise, new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('Cancelled'), { cancelled: true })), { once: true }))]);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function Header({ conn, transfers, width, loading, demo, mood }) {
  const segs = [{ text: `${FACES[mood]} `, color: theme.accent, bold: true }, { text: 'Mooring', bold: true }];
  if (demo) segs.push({ text: '  demo', color: theme.warn });
  segs.push({ text: '  │  ', color: theme.border });
  if (conn.status === 'connecting') segs.push({ text: `connecting to ${conn.host?.name}…`, color: theme.dim });
  else if (conn.session) segs.push({ text: `${BULLET} ${conn.host.name}`, color: theme.accent, bold: true }, { text: `  ${hostText(conn.host)}`, color: theme.dim });
  else segs.push({ text: 'not connected', color: theme.dim });
  const running = transfers.filter((t) => t.status === 'running').length;
  const waiting = transfers.filter((t) => t.status === 'queued').length;
  const failed = transfers.filter((t) => t.status === 'failed').length;
  if (running || waiting) segs.push({ text: `  ⇅ ${running} running${waiting ? `, ${waiting} waiting` : ''}`, color: theme.info });
  if (failed) segs.push({ text: `  ${failed} failed`, color: theme.del, bold: true });
  if (loading) segs.push({ text: '  reading…', color: theme.dim });
  if (conn.problem) segs.push({ text: '  │  ', color: theme.border }, { text: firstLine(conn.problem), color: theme.warn });
  return <Row pointer={false} width={width} segments={segs} />;
}

/** The tabs' labels and the columns each one covers (`from` up to `to`), which clicks are matched against. */
function tabLabels(entries, transfers) {
  let x = 0;
  return VIEWS.map((v, i) => {
    let text = ` ${i + 1} ${v.label}`;
    if (v.id === 'log' && entries.length) text += ` ${entries.length}`;
    if (v.id === 'transfers') {
      const open = transfers.filter((t) => t.status === 'queued' || t.status === 'running').length;
      if (open) text += ` ${open}`;
    }
    text += ' ';
    const from = x;
    x += stringWidth(text) + 1;
    return { id: v.id, label: text, from, to: from + stringWidth(text) };
  });
}

function Tabs({ view, entries, transfers, width }) {
  const segs = [];
  const failed = transfers.some((t) => t.status === 'failed');
  for (const t of tabLabels(entries, transfers)) {
    const on = t.id === view;
    segs.push({ text: t.label, bg: on ? theme.accent : undefined, color: on ? theme.ink : t.id === 'transfers' && failed ? theme.del : theme.dim, bold: on }, { text: ' ' });
  }
  return <Row pointer={false} width={width} segments={segs} />;
}

// The last two results, Claude Code style: "● Deleted 3 items" then "  ⎿  output".
function activityRows(entries) {
  const out = [];
  for (const e of entries.slice(-2)) {
    const color = { error: theme.del, ok: theme.accent, running: theme.dim, info: theme.info }[e.status];
    out.push([{ text: `${BULLET} `, color }, { text: e.title, bold: e.status !== 'info' }]);
    const max = e.status === 'error' ? 3 : 2;
    e.lines.slice(0, max).forEach((l, i) => out.push([{ text: i === 0 ? '  ⎿  ' : '     ', color: theme.dim }, { text: l, color: e.status === 'error' ? theme.del : theme.dim }]));
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

const emptyPane = (dir) => ({ dir, entries: [], problem: null, loading: false, marks: new Set(), select: null });
const NO_CONN = { host: null, session: null, status: 'none', problem: null };

// `local` is local.js's createLocal (demoLocal), `makeSession(host)` session.js's createSession (the
// demo's host). `copy` puts plain text on the clipboard. `openUrl` is unused for now; `checkUpdate` and
// `installUpdate` come only in the downloaded builds, so tests and checkouts never go online or replace
// anything. `connectTo` is a host (or the name of a saved one) to open at start. `persist` is whether
// settings are written to the config file (not in the demo).
export function App({ config: initialConfig, local, makeSession, connectTo, copy, setTitle, mouse, checkUpdate, installUpdate, onConfig, persist = true, moodEvery = 30_000, demo = false }) {
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize();
  const [config, setConfigState] = useState(initialConfig);
  const [conn, setConnState] = useState(NO_CONN);
  const [panes, setPanesState] = useState(() => ({ local: emptyPane(local.dir), remote: emptyPane('/') }));
  const [transfers, setTransfers] = useState([]);
  const [side, setSideState] = useState('local');
  const [view, setView] = useState('files');
  const [focus, setFocusState] = useState('view');
  const [prompt, setPromptState] = useState({ value: '', cursor: 0 });
  const [sugIndex, setSugIndex] = useState(0);
  const [overlay, setOverlayState] = useState(null);
  const [confirmReq, setConfirmReq] = useState(null);
  const [entries, setEntries] = useState([]);
  const [busy, setBusy] = useState(null);
  const [update, setUpdate] = useState(null);
  const [history, setHistory] = useState([]);
  const [welcome, setWelcome] = useState(true);
  const [loaded, setLoaded] = useState(false);
  // The pet looks happy (or worried) for a few seconds after a result; re-render when that wears off.
  const [, setMoodTick] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setMoodTick((n) => n + 1), 8100);
    return () => clearTimeout(t);
  }, [entries]);
  // A sibling's mood Tug reacts to (family.js's readMoods, every `moodEvery` ms): one line until esc.
  const [reaction, setReaction] = useState(null);
  const reactionRef = useRef(null);
  reactionRef.current = reaction;
  const seenMoods = useRef(new Set());
  useEffect(() => {
    if (config.familyMoods === false || !moodEvery) return setReaction(null);
    const look = () => {
      const r = reactionTo(readMoods('mooring'), seenMoods.current);
      if (!r) return;
      seenMoods.current.add(r.key);
      setReaction(r);
    };
    look();
    const t = setInterval(look, moodEvery);
    return () => clearInterval(t);
  }, [config.familyMoods, moodEvery]);
  // A word in the bottom line for a moment ("Copied 3 lines"), where it moves nothing on screen.
  const [flash, setFlash] = useState(null);
  const nothingToCopy = () => setFlash({ text: 'Drag over text to copy it · q quits' });
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 3000);
    return () => clearTimeout(t);
  }, [flash]);

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
  const connRef = useRef(NO_CONN);
  const panesRef = useRef(panes);
  const sideRef = useRef('local');
  const busyRef = useRef(null);
  const configRef = useRef(config);
  const promptRef = useRef(prompt);
  const confirmRef = useRef(null);
  const focusRef = useRef('view');
  const overlayRef = useRef(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const nextId = useRef(1);
  const loadSeq = useRef({ local: 0, remote: 0 });
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

  const setConn = (next) => {
    connRef.current = next;
    setConnState(next);
  };
  const updatePane = (which, patch) => {
    panesRef.current = { ...panesRef.current, [which]: { ...panesRef.current[which], ...patch } };
    setPanesState(panesRef.current);
  };
  const setSide = (s) => {
    sideRef.current = s;
    setSideState(s);
  };
  const setConfig = (next) => {
    const value = typeof next === 'function' ? next(configRef.current) : next;
    configRef.current = value;
    setConfigState(value);
    if (persist) saveConfig(value);
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

  // A pane's folder read: both panes the same way, the listing replacing the old one only once it is here.
  const loadPane = async (which, dir, { select = null } = {}) => {
    const seq = ++loadSeq.current[which];
    updatePane(which, { loading: true });
    try {
      const list = await (which === 'local' ? local.list(dir) : sessionRef.current.list(dir));
      if (!alive.current || seq !== loadSeq.current[which]) return false;
      updatePane(which, { dir, entries: list, problem: null, loading: false, marks: new Set(), select });
      return true;
    } catch (e) {
      if (!alive.current || seq !== loadSeq.current[which]) return false;
      updatePane(which, { loading: false });
      note(`${dir}: ${firstLine(e.message)}`, 'error');
      return false;
    }
  };

  // Transfers go to whichever session is open now; the queue outlives a connection.
  const sessionRef = useRef(null);
  const needSession = () => {
    if (!sessionRef.current) throw new SessionError('Not connected');
    return sessionRef.current;
  };
  const refreshTimers = useRef({});
  const refreshLater = (which) => {
    clearTimeout(refreshTimers.current[which]);
    refreshTimers.current[which] = setTimeout(() => alive.current && (which === 'local' || sessionRef.current) && loadPane(which, panesRef.current[which].dir), 300);
  };
  const seenDone = useRef(new Set());
  const wasBusy = useRef(false);
  const queueRef = useRef(null);
  if (!queueRef.current) {
    queueRef.current = createQueue({
      session: { get: (...args) => needSession().get(...args), put: (...args) => needSession().put(...args) },
      concurrency: config.transfers ?? 2,
      onChange: (items) => {
        if (!alive.current) return;
        setTransfers(items);
        for (const item of items) {
          if (item.status === 'done' && !seenDone.current.has(item.id)) {
            seenDone.current.add(item.id);
            refreshLater(item.kind === 'upload' ? 'remote' : 'local');
          }
          if (item.status === 'failed' && !seenDone.current.has(`f${item.id}:${item.finishedAt}`)) {
            seenDone.current.add(`f${item.id}:${item.finishedAt}`);
            note(`${item.kind === 'upload' ? 'Upload' : 'Download'} of ${item.name} failed: ${firstLine(item.error)}`, 'error');
          }
        }
        const open = items.some((i) => i.status === 'queued' || i.status === 'running');
        if (wasBusy.current && !open) {
          const done = items.filter((i) => i.status === 'done').length;
          const bad = items.filter((i) => i.status === 'failed').length;
          if (done || bad) note(`Transfers finished: ${done} done${bad ? `, ${bad} failed` : ''}`, bad ? 'error' : 'ok');
          const sent = items.filter((i) => i.kind === 'upload' && i.status === 'done' && !seenDone.current.has(`u${i.id}`));
          for (const i of sent) seenDone.current.add(`u${i.id}`);
          if (sent.length && configRef.current.familyMoods !== false) {
            logActivity('mooring', { text: `uploaded ${sent.length === 1 ? sent[0].name : `${sent.length} items`} to ${connRef.current.host?.name ?? 'a host'}`, kind: 'change', project: panesRef.current.local.dir });
          }
        }
        wasBusy.current = open;
      },
    });
  }
  const queue = queueRef.current;

  const disconnect = () => {
    queue.cancelAll();
    sessionRef.current?.close();
    sessionRef.current = null;
    loadSeq.current.remote++;
    const was = connRef.current.host;
    setConn(NO_CONN);
    updatePane('remote', { ...emptyPane('/') });
    if (sideRef.current === 'remote') setSide('local');
    if (was) note(`Disconnected from ${was.name}`);
  };

  const task = async (title, start, { label: what = 'Working', activity, kind = 'change' } = {}) => {
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
      // What changed something goes in the family's activity log: what, never a command's text.
      if (activity && configRef.current.familyMoods !== false) logActivity('mooring', { text: activity, kind, project: panesRef.current.local.dir });
      return { ok: true, out, result };
    } catch (error) {
      errorCount.current++;
      lastOutput.current = { title, text: error.message };
      updateEntry(id, { status: 'error', lines: error.cancelled ? ['Cancelled'] : error.message.split('\n') });
      return { ok: false, error };
    } finally {
      busyRef.current = null;
      setBusy(null);
    }
  };

  // Opens `host`: its home (or the host's `folder`) on the right.
  const connect = async (host) => {
    if (connRef.current.status === 'connecting') return note('Already connecting: esc cancels it.', 'error') ?? false;
    if (connRef.current.host) disconnect();
    // A host that signs in with a password asks for it each time, masked; it goes to the session and nowhere else.
    let password;
    if (host.password) {
      password = await ctx.askSecret({ title: `Password for ${hostText(host)}`, detail: 'asked every time, never saved · ↵ connect · esc cancel' });
      if (!password) return note(`Not connecting to ${host.name}: no password given.`) ?? false;
    }
    const session = makeSession(host, { password });
    password = undefined;
    setConn({ host, session: null, status: 'connecting', problem: null });
    const r = await task(
      `Connecting to ${host.name}`,
      async (signal) => ({ home: await abortable(session.home(), signal), stdout: hostText(host) }),
      { label: `Connecting to ${host.name}` },
    );
    if (!r.ok) {
      session.close();
      setConn({ host: null, session: null, status: 'error', problem: firstLine(r.error.message) });
      return false;
    }
    sessionRef.current = session;
    setConn({ host, session, status: 'ready', problem: null });
    setConfig((c) => ({ ...c, last: host.name }));
    setSide('remote');
    setView('files');
    const home = r.result.home;
    if (!(host.folder && (await loadPane('remote', host.folder)))) await loadPane('remote', home);
    return true;
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

  // $ <command>: runs it on the server in the folder the right pane shows, its output in Console as it
  // arrives. `cd` moves that pane instead, as a command run alone could not. One at a time.
  const remoteRun = useRef(null);
  const runRemote = async (command) => {
    const session = sessionRef.current;
    if (!session) return note('Not connected: /connect <host>', 'error') ?? false;
    if (!command) return note('Type a command after $, e.g. $ ls -l', 'error') ?? false;
    if (remoteRun.current) return note('A command is running on the server: x in Console cancels it.', 'error') ?? false;
    const cd = command.match(/^cd(?:\s+(.*))?$/);
    if (cd) return a.cd(ctx, 'remote', cd[1]?.trim() || '~');
    const dir = panesRef.current.remote.dir;
    const id = nextId.current++;
    const controller = new AbortController();
    remoteRun.current = { id, abort: () => controller.abort() };
    const patch = (p) => setHistory((list) => list.map((h) => (h.id === id ? { ...h, ...p } : h)));
    setHistory((list) => [...list.slice(-49), { id, host: connRef.current.host.name, dir, command, status: 'running', out: '', err: '', code: null }]);
    setWelcome(false);
    setView('console');
    let out = '';
    try {
      const r = await session.exec(`cd ${shellQuote(dir)} && ${command}`, {
        signal: controller.signal,
        onData: (d) => {
          out = (out + d).slice(-200_000);
          patch({ out });
        },
      });
      patch({ status: r.code === 0 ? 'done' : 'failed', code: r.code, out: r.stdout.slice(-200_000), err: r.stderr });
      return r.code === 0;
    } catch (e) {
      patch({ status: e.cancelled ? 'cancelled' : 'failed', err: e.cancelled ? '' : e.message, code: null });
      if (!e.cancelled) errorCount.current++;
      return false;
    } finally {
      remoteRun.current = null;
    }
  };

  const ctxRef = useRef(null);
  if (!ctxRef.current) ctxRef.current = { get config() { return configRef.current; }, get panes() { return panesRef.current; }, get conn() { return connRef.current; }, get session() { return sessionRef.current; }, mouseHandlers: [] };
  const ctx = ctxRef.current;
  Object.assign(ctx, {
    local,
    queue,
    task,
    note,
    confirm,
    // A masked field in the confirm's place: resolves the text (or null on esc).
    askSecret: async (req) => (await confirm({ ...req, secret: true, options: [] }))?.value ?? null,
    // A plain field in the confirm's place: resolves the text (or null on esc).
    askText: async (req) => (await confirm({ ...req, secret: true, plain: true, options: [] }))?.value ?? null,
    prefill,
    connect,
    disconnect,
    runRemote,
    cancelRemote: () => (remoteRun.current ? remoteRun.current.abort() : note('Nothing is running on the server.')),
    clearConsole: () => setHistory((list) => list.filter((h) => h.status === 'running')),
    loadPane,
    side: () => sideRef.current,
    setSide,
    setView,
    toggleMark: (which, name) => {
      const marks = new Set(panesRef.current[which].marks);
      if (!marks.delete(name)) marks.add(name);
      updatePane(which, { marks });
    },
    setHidden: (on) => {
      setConfig((c) => ({ ...c, showHidden: on }));
      note(on ? 'Showing files that start with a dot' : 'Hiding files that start with a dot');
      return true;
    },
    refresh: () => readAll(),
    setConfig,
    // /update: asks for the latest release now, whatever the daily check last said, and installs it.
    updateNow: () => {
      if (askHostToUpdate()) return note('Asked Fleet to look for a new version of the whole fleet.');
      if (!checkUpdate) return note(`This Mooring (${VERSION}) runs from a checkout: git pull updates it.`);
      if (update?.state === 'installing') return note(`Mooring ${update.latest} is being installed already.`);
      if (update?.state === 'installed') return note(`Mooring ${update.latest} is installed. It starts the next time you open Mooring.`);
      const said = (text) => ({ stdout: text, stderr: '' });
      return task(
        'Looking for a new version of Mooring',
        async () => {
          const { checked, newer } = await checkUpdate(null);
          setConfig((c) => ({ ...c, lastUpdateCheck: checked }));
          if (!newer) return said(`Mooring ${VERSION} is the latest version.`);
          if (!installUpdate) {
            setUpdate({ ...checked, state: 'out' });
            return said(`Mooring ${checked.latest} is out (you have ${VERSION}). Download it from ${checked.url}`);
          }
          setUpdate({ ...checked, state: 'installing' });
          try {
            await installUpdate(checked.latest);
          } catch (e) {
            setUpdate({ ...checked, state: 'out' });
            throw new Error(`Mooring ${checked.latest} is out, but it couldn't be installed: ${firstLine(e.message)}\nDownload it from ${checked.url}`);
          }
          setUpdate({ ...checked, state: 'installed' });
          return said(`Mooring ${checked.latest} is installed. It starts the next time you open Mooring.`);
        },
        { label: 'Updating Mooring' },
      );
    },
    // Text that isn't secret to the clipboard, said in the bottom line as "Copied <what>".
    copy: (text, what = text) => {
      if (!copy) return note("Copying to the clipboard isn't available here.", 'error');
      copy(text);
      setFlash({ text: `Copied ${what}` });
    },
    // Views call this first in their key handlers, for the same reason as the dispatcher below.
    viewHasKeys: () => focusRef.current === 'view' && !overlayRef.current && !confirmRef.current && answerKey.current !== keySeq.current,
    overlayHasKeys: () => focusRef.current === 'view' && !confirmRef.current && answerKey.current !== keySeq.current,
    quit: () => exit(),
    showText: (title, text, opts = {}) => setOverlay({ title, text, ...opts }),
    showPicker: (picker) => setOverlay({ kind: 'picker', picker }),
    refreshPicker: () => setOverlay((o) => (o?.kind === 'picker' ? { ...o, picker: { ...o.picker } } : o)),
    closeOverlay: () => setOverlay(null),
    showHelp: () => setOverlay({ kind: 'help', start: sectionFor(customRef.current.sections, viewRef.current) }),
    openPalette: () => openPalette(),
    runLine: (text) => runLine(text),
    showLast: () => (lastOutput.current ? setOverlay({ ...lastOutput.current }) : note('No command has run yet.')),
  });

  // Both folders read again (and the server's only when connected).
  const readAll = async () => {
    await Promise.all([loadPane('local', panesRef.current.local.dir), sessionRef.current ? loadPane('remote', panesRef.current.remote.dir) : null]);
  };

  // One line as typed at the prompt: a shell command after !, else a slash command. Resolves false
  // when it failed: it threw, said an error, or a question it asked was answered no (so your own
  // commands stop there).
  const runLine = async (text) => {
    const [errors, declined] = [errorCount.current, declines.current];
    try {
      let r;
      if (text.startsWith('!')) r = await a.raw(ctx, text.slice(1).trim());
      else if (text.startsWith('$')) r = await runRemote(text.slice(1).trim());
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

  // Read this machine's folder on opening, open the host asked for; then look for a newer release.
  useEffect(() => {
    (async () => {
      await loadPane('local', local.dir);
      if (!alive.current) return;
      setLoaded(true);
      if (custom.problems.length) note(`Your settings file has ${plural(custom.problems.length, 'problem')}:\n${custom.problems.join('\n')}`, 'error');
      if (connectTo) {
        const host = typeof connectTo === 'string' ? (configRef.current.hosts ?? []).find((h) => h.name === connectTo) : connectTo;
        if (host) await connect(host);
        else note(`There's no saved host ${connectTo}: /add saves one.`, 'error');
      }
      if (checkUpdate && configRef.current.checkForUpdates !== false) {
        checkUpdate(configRef.current.lastUpdateCheck).then(
          ({ checked, newer }) => {
            setConfig((c) => ({ ...c, lastUpdateCheck: checked }));
            if (!newer) return;
            const outNote = (why = '') => note(`Mooring ${checked.latest} is out (you have ${VERSION})${why}.\nDownload it from ${checked.url}`);
            if (!installUpdate || configRef.current.autoUpdate === false) {
              setUpdate({ ...checked, state: 'out' });
              return outNote();
            }
            // In the background, without the spinner: nothing waits on it, and it only counts from the next start.
            setUpdate({ ...checked, state: 'installing' });
            installUpdate(checked.latest).then(
              () => {
                setUpdate({ ...checked, state: 'installed' });
                note(`Mooring ${checked.latest} is installed. It starts the next time you open Mooring.`);
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
    // Leaving closes the connection and stops what is transferring.
    return () => {
      queue.cancelAll();
      sessionRef.current?.close();
      for (const t of Object.values(refreshTimers.current)) clearTimeout(t);
    };
  }, []);

  // cli.jsx passes the terminal's title setter; tests pass a stub or nothing.
  const title = `${VIEW_LABELS[view]} — Mooring`;
  useEffect(() => {
    setTitle?.(title);
  }, [title]);

  const data = { hosts: config.hosts ?? [], panes };
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
    const items = suggestionsFor(value, { data: { hosts: configRef.current.hosts ?? [], panes: panesRef.current }, user: customRef.current.commands });
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
    // A paste of a command line opens the prompt with it, to run with enter.
    const pasted = pastedLine(input);
    if (pasted) return prefill(pasted);
    if (input === '/' || input === ':') return prefill('/');
    if (input === '!') return prefill('!');
    if (input === '$') return prefill('$ ');
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
  const trouble = troubles({ transfers, conn });
  const moving = transfers.filter((t) => t.status === 'running').length;
  const working = moving > 0 || history.some((h) => h.status === 'running');
  const mood = moodFor({ loaded, connected: Boolean(conn.session), busy, running: working, lastEntry: entries.at(-1), trouble });
  // How Tug feels, for the siblings (family.js's writeMood), whenever that changes.
  const said = familyMood({ mood, trouble, lastEntry: entries.at(-1), busy, host: conn.host?.name });
  useEffect(() => {
    if (config.familyMoods !== false) writeMood('mooring', said);
  }, [said.mood, said.reason, config.familyMoods]);
  const showWelcome = welcome && H >= 28;
  const reacting = reaction ? 1 : 0;
  const mainH = Math.max(6, H - 2 - reacting - act.length - (busy ? 1 : 0) - bottom - 1 - (showWelcome ? WELCOME_HEIGHT : 0));
  const viewActive = focus === 'view' && !overlay && !confirmReq;
  layout.current = {
    mainTop: 2,
    mainH,
    promptTop: 2 + mainH + (showWelcome ? WELCOME_HEIGHT : 0) + reacting + act.length + (busy ? 1 : 0),
    sugCount: suggestions.length,
    tabs: tabLabels(entries, transfers),
  };

  // The palette's list: this view's keys, yours, then the commands.
  const paletteList = useMemo(
    () => paletteItems({ commands: COMMANDS, user: custom.commands, sections: HELP.filter((s) => s.title === 'Anywhere' || s.views?.includes(view)), keymap: custom.keymap, view, skip: ['ctrl+p'] }),
    [custom, view],
  );

  const loading = panes.local.loading || panes.remote.loading;
  const overlayActive = focus === 'view' && !confirmReq;
  let main;
  if (overlay?.kind === 'help') {
    main = <HelpView sections={custom.sections} start={overlay.start} ctx={ctx} width={W} height={mainH} active={overlayActive} onClose={() => queueMicrotask(ctx.closeOverlay)} />;
  } else if (overlay?.kind === 'palette') {
    main = <Palette items={paletteList} query={overlay.query} ctx={ctx} width={W} height={mainH} active={overlayActive} onPick={runPicked} onClose={() => queueMicrotask(ctx.closeOverlay)} />;
  } else if (overlay?.kind === 'picker') {
    main = <Picker key={viewerKey(overlay)} picker={overlay.picker} ctx={ctx} width={W} height={mainH} active={overlayActive} />;
  } else if (overlay) {
    main = <Viewer key={viewerKey(overlay)} title={overlay.title} text={overlay.text} lines={overlay.lines} onKey={overlay.onKey} ctx={ctx} width={W} height={mainH} active={overlayActive} onClose={() => queueMicrotask(ctx.closeOverlay)} />;
  } else if (view === 'log') {
    main = <LogView entries={entries} ctx={ctx} width={W} height={mainH} active={viewActive} />;
  } else if (view === 'console') {
    main = <ConsoleView history={history} conn={conn} ctx={ctx} width={W} height={mainH} active={viewActive} />;
  } else if (view === 'hosts') {
    main = <HostsView hosts={config.hosts ?? []} conn={conn} ctx={ctx} width={W} height={mainH} active={viewActive} />;
  } else if (view === 'transfers') {
    main = <TransfersView items={transfers} ctx={ctx} width={W} height={mainH} active={viewActive} />;
  } else {
    main = <FilesView panes={panes} side={side} conn={conn} hidden={config.showHidden !== false} ctx={ctx} width={W} height={mainH} active={viewActive} />;
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

  return (
    <Box flexDirection="column" width={W} height={H}>
      <Header conn={conn} transfers={transfers} width={W} loading={loading} demo={demo} mood={mood} />
      <Tabs view={view} entries={entries} transfers={transfers} width={W} />
      <Box height={mainH} width={W}>
        {main}
      </Box>
      {showWelcome ? <Welcome mood={mood} info={{ loaded, connected: Boolean(conn.session), host: conn.host?.name, trouble, running: moving, hosts: (config.hosts ?? []).length }} width={W} update={update} /> : null}
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
