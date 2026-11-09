import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, useApp, useInput, useStdin } from 'ink';
import { basename } from 'node:path';
import * as a from '../actions.js';
import { COMMANDS, findCommand, suggestionsFor } from '../commands.js';
import { saveConfig } from '../config.js';
import { HELP } from '../help.js';
import { commandsSection, sectionFor } from '@fleet/kit/help-layout.js';
import { askHostToUpdate } from '@fleet/kit/hosted.js';
import { createLookout } from '../provider.js';
import { filtered, hosts as hostsOf } from '../exchange.js';
import { trafficFindings } from '../security.js';
import { countFindings, findingsLine, securityJson } from '@fleet/kit/findings.js';
import { BULLET, theme } from '../theme.js';
import { VERSION } from '../app.js';
import { useEnvironment, useKeyTranslation, useTerminalSize } from '@fleet/kit/ui/hooks.js';
import { recordCommand } from '@fleet/kit/recording.js';
import { shortcutKey } from '@fleet/kit/keymap.js';
import { remember } from '@fleet/kit/folders.js';
import { Confirm, PromptBox, Row, SecretPrompt, Spinner, commandBoxFor, commandBoxHit, commandRows, confirmHeight, promptRowFor } from '@fleet/kit/ui/parts.jsx';
import { StatusLine, topLine, welcomeLine } from '@fleet/kit/ui/shell.jsx';
import { HelpView } from '@fleet/kit/ui/HelpView.jsx';
import { DataViewer } from '@fleet/kit/ui/DataViewer.jsx';
import { RequestsView } from './RequestsView.jsx';
import { HostsView } from './HostsView.jsx';
import { SecurityView } from './SecurityView.jsx';
import { SetupView } from './SetupView.jsx';
import { DetailView } from './DetailView.jsx';
import { LogView } from './LogView.jsx';
import { Viewer } from './Viewer.jsx';
import { updateLine } from './Pet.jsx';
import { FACES, PET, moodFor, moodLine } from '../pet.js';
import { decodeContext, logActivity, pastedLine, readMoods, writeMood } from '@fleet/kit/family.js';
import { familyMood, reactionTo } from '../moods.js';

const VIEWS = [
  { id: 'requests', label: 'Requests' },
  { id: 'hosts', label: 'Hosts' },
  { id: 'security', label: 'Security' },
  { id: 'setup', label: 'Setup' },
  { id: 'log', label: 'Log' },
];

const HINTS = {
  requests: '↵ details · h to Hail · t copy for Hail · f filter · p pass host through · y copy URL · e export HAR · c clear · space pause',
  hosts: '↵ its requests · p pass through or intercept · y copy',
  security: '↵ details · y copy where',
  setup: 'y copy HTTPS_PROXY · b Bosun env · c CA path · i HTTPS interception · j k scroll',
  log: '↵ all its output · y copy it',
};

const HELP_SECTIONS = [...HELP, commandsSection(COMMANDS)];
const DOUBLE_CLICK_MS = 400;
// The most exchanges kept: the oldest go first. Each keeps at most maxBody of each body.
const MAX_EXCHANGES = 5000;
// How often what came in reaches the screen, and the family's activity log.
const DRAW_EVERY = 100;
const LOG_EVERY = 5 * 60_000;
const firstLine = (s) => String(s ?? '').split('\n')[0];

// What the top line says at its right, most needed first, as what doesn't fit is left off from the end:
// what went wrong, where it listens, paused, the findings, how many it captured, the environment, the
// folder.
function headerContext({ cwd, env, listening, intercept, paused, count, findings, problem }) {
  const segs = [];
  if (problem) segs.push({ text: firstLine(problem), color: theme.warn }, { text: '  ' });
  if (listening) segs.push({ text: `${listening.host}:${listening.port}`, color: theme.accent }, { text: intercept ? '  HTTPS read' : '  HTTPS tunnelled', color: theme.dim }, { text: '  ' });
  else segs.push({ text: 'not listening', color: theme.warn, need: true }, { text: '  ' });
  if (paused) segs.push({ text: 'paused', color: theme.warn, bold: true, need: true }, { text: '  ' });
  const line = findingsLine(countFindings(findings));
  if (line) segs.push({ text: line, color: findings.some((f) => f.severity === 'critical' || f.severity === 'high') ? theme.del : theme.warn }, { text: '  ' });
  segs.push({ text: `${count} captured`, color: theme.dim });
  if (env) segs.push({ text: '  ' }, { text: env.prod ? `${env.name} (production)` : env.name, color: env.prod ? theme.del : theme.dim, bold: env.prod, need: env.prod });
  segs.push({ text: '  ' }, { text: basename(cwd) || cwd, color: theme.dim });
  return segs;
}

// The views in the top line, the digit that picks each before it and its count after it.
const viewTabs = (counts) => VIEWS.map((v, i) => ({ id: v.id, key: i + 1, label: v.label, count: counts[v.id] || 0, countColor: theme.dim }));

// The last two results, Claude Code style: "● listen on 8888" then "  ⎿  output".
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

// `provider` is provider.js's (demo.js's for --demo and the tests); `cwd` the folder .http files and HAR
// exports go to; `port` the --port given. `copy` puts text on the clipboard (cli.jsx's; tests pass a
// stub), `openUrl` opens the browser. `checkUpdate` and `installUpdate` come only in the downloaded
// builds, so tests and checkouts never go online for them or replace anything.
export function App({ config: initialConfig, provider = createLookout(), cwd: startDir = process.cwd(), port: portArg = null, moodEvery = 30_000, openUrl, setTitle, mouse, copy, checkUpdate, installUpdate }) {
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize();
  const [config, setConfigState] = useState(initialConfig);
  const [cwd, setCwdState] = useState(startDir);
  const [problem, setProblem] = useState(null);
  const [view, setView] = useState('requests');
  const [focus, setFocusState] = useState('view');
  const [prompt, setPromptState] = useState({ value: '', cursor: 0 });
  const [sugIndex, setSugIndex] = useState(0);
  const [overlay, setOverlayState] = useState(null);
  const [confirmReq, setConfirmReq] = useState(null);
  const [entries, setEntries] = useState([]);
  const [busy, setBusy] = useState(null);
  const [progress, setProgress] = useState('');
  const [welcome, setWelcome] = useState(true);
  const [update, setUpdate] = useState(null);
  const [listening, setListeningState] = useState(null);
  const [paused, setPausedState] = useState(false);
  const [filter, setFilterState] = useState('');
  // What was captured lives in a ref, changed as the proxy reports; `version` draws it again, at most every DRAW_EVERY ms.
  const exchangesRef = useRef([]);
  const knownRef = useRef(new Set());
  const unloggedRef = useRef([]);
  const [version, setVersion] = useState(0);
  const drawTimer = useRef(null);
  const nextExchange = useRef(1);
  // The project's environment (the kit's environments.js), followed as it's switched here or in another app.
  const env = useEnvironment('lookout', cwd);
  const envRef = useRef(env);
  envRef.current = env;
  // The pet looks happy (or worried) for a few seconds after a result; re-render when that wears off.
  const [, setMoodTick] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setMoodTick((n) => n + 1), 8100);
    return () => clearTimeout(t);
  }, [entries]);
  // A word in the bottom line for a moment ("Copied 3 lines"), where it moves nothing on screen.
  const [flash, setFlash] = useState(null);
  const nothingToCopy = () => setFlash({ text: 'Drag over text to copy it · q quits' });
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 3000);
    return () => clearTimeout(t);
  }, [flash]);

  // A sibling's mood Peep reacts to (family.js's readMoods, every `moodEvery` ms): one line until esc.
  const [reaction, setReaction] = useState(null);
  const reactionRef = useRef(null);
  reactionRef.current = reaction;
  const seenMoods = useRef(new Set());
  useEffect(() => {
    if (config.familyMoods === false || !moodEvery) return setReaction(null);
    const look = () => {
      const r = reactionTo(readMoods('lookout'), seenMoods.current);
      if (!r) return;
      seenMoods.current.add(r.key);
      setReaction(r);
    };
    look();
    const t = setInterval(look, moodEvery);
    return () => clearInterval(t);
  }, [config.familyMoods, moodEvery]);

  // Async actions read the latest state through refs, not through stale closures.
  const cwdRef = useRef(startDir);
  const busyRef = useRef(null);
  const configRef = useRef(config);
  const promptRef = useRef(prompt);
  const confirmRef = useRef(null);
  const focusRef = useRef('view');
  const overlayRef = useRef(null);
  const listeningRef = useRef(null);
  const pausedRef = useRef(false);
  const filterRef = useRef('');
  const selectedRef = useRef(null);
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

  const setConfig = (next) => {
    const value = typeof next === 'function' ? next(configRef.current) : next;
    configRef.current = value;
    setConfigState(value);
    saveConfig(value);
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
  const setListening = (address) => {
    listeningRef.current = address;
    setListeningState(address);
  };
  const setPaused = (p) => {
    pausedRef.current = p;
    setPausedState(p);
  };
  const setFilter = (f) => {
    filterRef.current = f;
    setFilterState(f);
  };

  const redraw = () => {
    if (drawTimer.current) return;
    drawTimer.current = setTimeout(() => {
      drawTimer.current = null;
      if (alive.current) setVersion((v) => v + 1);
    }, DRAW_EVERY);
  };
  /** The proxy's report of an exchange, new or changed (the same object each time). */
  const onExchange = (ex) => {
    if (!knownRef.current.has(ex)) {
      knownRef.current.add(ex);
      // Numbered here: a proxy started again counts from 1, and a HAR file's have their own.
      ex.id = nextExchange.current++;
      const list = exchangesRef.current;
      list.push(ex);
      if (list.length > MAX_EXCHANGES) knownRef.current.delete(list.shift());
      unloggedRef.current.push(ex);
    }
    redraw();
  };

  const addEntry = (e) => {
    const id = nextId.current++;
    setEntries((list) => [...list.slice(-99), { id, lines: [], at: Date.now(), ...e }]);
    return id;
  };
  const updateEntry = (id, patch) => setEntries((list) => list.map((e) => (e.id === id ? { ...e, at: Date.now(), ...patch } : e)));
  const note = (text, status = 'info') => {
    const [title, ...lines] = String(text).split('\n');
    addEntry({ title, status, lines });
  };
  const alive = useRef(true);
  const starting = useRef(true);
  // Nothing captured goes in: actions.js's flushActivity gives it counts and host names only.
  const familyLog = (text, kind = 'info') => {
    if (configRef.current.familyMoods !== false) logActivity('lookout', { text, kind, project: cwdRef.current });
  };

  const task = async (title, start, { label = 'Working', activity } = {}) => {
    if (busyRef.current) {
      note(`Wait for "${busyRef.current.label}" to finish (esc cancels it).`, 'error');
      return { ok: false, error: new Error('busy') };
    }
    const controller = new AbortController();
    const b = { label, started: Date.now(), abort: () => controller.abort() };
    busyRef.current = b;
    setBusy(b);
    setProgress('');
    const id = addEntry({ title, status: 'running' });
    if (!starting.current) setWelcome(false);
    try {
      const result = await start(controller.signal);
      const { stdout = '', stderr = '' } = result;
      const out = [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join('\n');
      lastOutput.current = { title, text: out || '(no output)' };
      updateEntry(id, { status: 'ok', lines: out ? out.split('\n') : ['Done'] });
      setProblem(null);
      if (activity) familyLog(activity, 'change');
      return { ok: true, out, result };
    } catch (error) {
      const cancelled = error.cancelled || controller.signal.aborted;
      lastOutput.current = { title, text: error.message };
      updateEntry(id, { status: 'error', lines: cancelled ? ['Cancelled'] : error.message.split('\n') });
      return { ok: false, error };
    } finally {
      busyRef.current = null;
      if (alive.current) setBusy(null);
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

  const ctxRef = useRef(null);
  if (!ctxRef.current)
    ctxRef.current = {
      get config() {
        return configRef.current;
      },
      // { host, port } while the proxy listens, else null.
      get listening() {
        return listeningRef.current;
      },
      get paused() {
        return pausedRef.current;
      },
      get filter() {
        return filterRef.current;
      },
      // { name, prod, ... } from .fleet/project.json, or null when the project names no environments.
      get env() {
        return envRef.current;
      },
      mouseHandlers: [],
    };
  const ctx = ctxRef.current;
  Object.assign(ctx, {
    provider,
    port: portArg,
    cwd: () => cwdRef.current,
    // /move: another folder, remembered among the recent ones.
    moveTo: (dir) => {
      cwdRef.current = dir;
      setCwdState(dir);
      setConfig((c) => ({ ...c, recent: remember(c.recent ?? [], dir) }));
    },
    exchanges: () => exchangesRef.current,
    shown: () => filtered(exchangesRef.current, filterRef.current),
    selected: () => selectedRef.current,
    onExchange,
    setListening,
    setPaused,
    setFilter,
    clearExchanges: () => {
      exchangesRef.current = [];
      knownRef.current = new Set();
      unloggedRef.current = [];
      setVersion((v) => v + 1);
    },
    /** Exchanges from elsewhere (a HAR file). */
    addExchanges: (list) => {
      for (const ex of list) onExchange(ex);
    },
    /** What came in since the activity log was last told, handed over once. */
    takeUnlogged: () => {
      const list = unloggedRef.current.filter((ex) => !ex.imported);
      unloggedRef.current = [];
      return list;
    },
    task,
    note,
    confirm,
    prefill,
    progress: (text) => alive.current && setProgress(text),
    logActivity: familyLog,
    // Settings change through App's copy, the only one written to disk (ctx.config reads it).
    setConfig,
    setView: (v) => {
      if (overlayRef.current) setOverlay(null);
      setView(v);
    },
    openUrl: (url) => (openUrl ? openUrl(url) : note(`Open ${url}`)),
    // /update: asks for the latest release now, whatever the daily check last said, and installs it.
    updateNow: () => {
      if (askHostToUpdate()) return note('Asked Fleet to look for a new version of the whole fleet.');
      if (!checkUpdate) return note(`This Lookout (${VERSION}) runs from a checkout: git pull updates it.`);
      if (update?.state === 'installing') return note(`Lookout ${update.latest} is being installed already.`);
      if (update?.state === 'installed') return note(`Lookout ${update.latest} is installed. It starts the next time you open Lookout.`);
      const said = (text) => ({ stdout: text, stderr: '' });
      return task(
        'Looking for a new version of Lookout',
        async () => {
          const { checked, newer } = await checkUpdate(null);
          setConfig((c) => ({ ...c, lastUpdateCheck: checked }));
          if (!newer) return said(`Lookout ${VERSION} is the latest version.`);
          if (!installUpdate) {
            setUpdate({ ...checked, state: 'out' });
            return said(`Lookout ${checked.latest} is out (you have ${VERSION}). Download it from ${checked.url}`);
          }
          setUpdate({ ...checked, state: 'installing' });
          try {
            await installUpdate(checked.latest);
          } catch (e) {
            setUpdate({ ...checked, state: 'out' });
            throw new Error(`Lookout ${checked.latest} is out, but it couldn't be installed: ${firstLine(e.message)}\nDownload it from ${checked.url}`);
          }
          setUpdate({ ...checked, state: 'installed' });
          return said(`Lookout ${checked.latest} is installed. It starts the next time you open Lookout.`);
        },
        { label: 'Updating Lookout' },
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
    showText: (title, text) => setOverlay({ title, text }),
    showDetail: (ex) => setOverlay({ kind: 'detail', ex }),
    // A body in the data viewer; closing it goes back to what was open under it.
    showData: ({ title, text }) => setOverlay((was) => ({ kind: 'data', title, text, back: was })),
    closeOverlay: () => setOverlay((was) => was?.back ?? null),
    showHelp: () => setOverlay({ kind: 'help', start: sectionFor(HELP_SECTIONS, view) }),
    showLast: () => (lastOutput.current ? setOverlay({ ...lastOutput.current }) : note('No command has run yet.')),
  });

  // One line as typed at the prompt: a shell command after !, else a slash command. Resolves false when it failed.
  const runLine = async (text) => {
    try {
      if (text.startsWith('!')) return (await a.raw(ctx, text.slice(1).trim())) !== false;
      // A sibling's context pasted alone is /take's.
      if (decodeContext(text)) return (await a.takeContext(ctx, text)) !== false;
      const [, name, rest] = text.replace(/^\//, '').match(/^(\S+)\s*([\s\S]*)$/);
      const cmd = findCommand(name);
      if (!cmd) {
        note(`Unknown command: /${name}. Type / to see them all.`, 'error');
        return false;
      }
      const r = await cmd.run(ctx, rest.trim());
      return r !== false && r?.ok !== false;
    } catch (e) {
      note(firstLine(e.message), 'error');
      return false;
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
    // While Fleet records a runbook, the line goes in it (the kit keeps only slash commands and /take lines).
    recordCommand('lookout', decodeContext(text) ? `/take ${text}` : text);
  };

  // Listen on opening (unless that's turned off), then look for a newer release. Quitting stops the
  // proxy and tells the activity log what was captured.
  useEffect(() => {
    (async () => {
      if (configRef.current.autoStart !== false) await a.start(ctx);
      starting.current = false;
      if (!alive.current) return;
      if (checkUpdate && configRef.current.checkForUpdates !== false) {
        checkUpdate(configRef.current.lastUpdateCheck).then(
          ({ checked, newer }) => {
            setConfig((c) => ({ ...c, lastUpdateCheck: checked }));
            if (!newer) return;
            const outNote = (why = '') => note(`Lookout ${checked.latest} is out (you have ${VERSION})${why}.\nDownload it from ${checked.url}`);
            if (!installUpdate || configRef.current.autoUpdate === false) {
              setUpdate({ ...checked, state: 'out' });
              return outNote();
            }
            setUpdate({ ...checked, state: 'installing' });
            installUpdate(checked.latest).then(
              () => {
                setUpdate({ ...checked, state: 'installed' });
                note(`Lookout ${checked.latest} is installed. It starts the next time you open Lookout.`);
              },
              (e) => {
                setUpdate({ ...checked, state: 'out' });
                outNote(`, but it couldn't be installed: ${firstLine(e.message)}`);
              },
            );
          },
          () => {},
        );
      }
    })();
    const logTimer = setInterval(() => a.flushActivity(ctx), LOG_EVERY);
    return () => {
      alive.current = false;
      clearInterval(logTimer);
      clearTimeout(drawTimer.current);
      a.flushActivity(ctx);
      provider.stop?.();
    };
  }, []);

  // cli.jsx passes the terminal's title setter; tests pass a stub or nothing.
  const title = `${basename(cwd) || cwd} · ${VIEWS.find((v) => v.id === view).label} — Lookout`;
  useEffect(() => {
    setTitle?.(title);
  }, [title]);

  // What's drawn, worked out again when something came in (version) or the filter changed.
  const list = exchangesRef.current;
  const shown = useMemo(() => filtered(list, filter), [version, filter, list]);
  const hostList = useMemo(() => hostsOf(list), [version, list]);
  const findings = useMemo(() => trafficFindings(list), [version, list]);
  const open = list.reduce((n, ex) => n + (ex.kind === 'http' && ex.state === 'open' ? 1 : 0), 0);
  const refused = list.reduce((n, ex) => n + (ex.kind === 'refused' ? 1 : 0), 0);
  const serious = findings.filter((f) => f.severity === 'critical' || f.severity === 'high').length;

  // The last session's findings, for `lookout security` (only the findings: never the traffic), a moment after they change.
  useEffect(() => {
    if (!list.length || provider.demo) return;
    const t = setTimeout(() => provider.saveFindings?.(securityJson({ app: 'lookout', check: 'traffic', target: 'last session', findings, extra: { requests: list.length, hosts: hostList.length } })), 2000);
    return () => clearTimeout(t);
  }, [findings]);

  const suggestions = focus === 'prompt' && !confirmReq ? suggestionsFor(prompt.value, { exchanges: list, config, cwd }) : [];
  const sel = Math.min(sugIndex, Math.max(0, suggestions.length - 1));

  // Uppercase shortcuts are alt+letter (caps lock can't fire them); typing in a prompt or a confirm is left alone.
  const sendKey = useKeyTranslation((input) => {
    if (focusRef.current === 'view' && !confirmRef.current && overlayRef.current?.kind !== 'help') return shortcutKey(input);
    return input;
  });
  void sendKey;

  // Line editing in the prompt.
  const promptKeys = (input, key) => {
    const { value, cursor } = promptRef.current;
    const items = suggestionsFor(value, { exchanges: exchangesRef.current, config: configRef.current, cwd: cwdRef.current });
    const pick = items[Math.min(sugIndex, items.length - 1)];
    const edit = (v, c) => {
      setPrompt(v, c);
      setSugIndex(0);
    };
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
        setEntries((l) => l.map((e) => ({ ...e, shown: false })));
        setWelcome(false);
      }
      return;
    }
    // A paste of a command line (or a sibling's family:v1: context) opens the prompt with it, to run with enter.
    const pasted = pastedLine(input);
    if (pasted) return prefill(pasted);
    if (input === '/' || input === ':') return prefill('/');
    if (input === '!') return prefill('!');
    if (input === '?') return ctx.showHelp();
    if (input === ',') return a.settings(ctx);
    if (input === ' ') return a.pause(ctx);
    if (input === 'q') return exit();
    const n = Number(input);
    if (n >= 1 && n <= VIEWS.length) return setView(VIEWS[n - 1].id);
    if (key.tab) {
      const i = VIEWS.findIndex((v) => v.id === view);
      return setView(VIEWS[(i + (key.shift ? VIEWS.length - 1 : 1)) % VIEWS.length].id);
    }
  };

  // One dispatcher reading focus from refs, which change the instant focus moves.
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

  const tabCounts = { requests: list.length, hosts: hostList.length, security: findings.length, log: entries.length };

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
    // While the command box is open over the view, a click in it is its own and one outside it closes it.
    const inBox = commandBoxHit(layout.current.box, e);
    if (inBox === false) return e.drag || e.wheel ? undefined : setFocus('view');
    if (inBox && (e.drag || e.wheel)) return;
    if (e.drag) {
      const hit = mouseTarget(e.from.y - mainTop);
      if (!hit) return;
      if (focusRef.current === 'prompt') setFocus('view');
      return hit.target.handle({ ...e, y: e.y - mainTop - hit.target.top, from: { x: e.from.x, y: hit.y } });
    }
    if (e.y === mainTop - 1 && !e.wheel) {
      const tab = tabs.find((t) => e.x >= t.from && e.x < t.to);
      if (!tab) return;
      if (overlayRef.current) setOverlay(null);
      setFocus('view');
      return setView(tab.id);
    }
    if (!inBox && e.y >= mainTop && e.y < mainTop + mainH) {
      if (!e.wheel && focusRef.current === 'prompt') setFocus('view');
      const hit = mouseTarget(e.y - mainTop);
      return hit?.target.handle({ ...e, y: hit.y });
    }
    if (e.wheel) return;
    if (e.y === promptTop) {
      // The text starts after the box's edge and "» ", scrolled as the command box scrolls it.
      const { value, cursor } = promptRef.current;
      const inner = layout.current.box?.inner ?? columns - 3;
      const start = focusRef.current === 'prompt' ? Math.max(0, cursor - inner + 1) : 0;
      setPrompt(value, Math.max(0, Math.min(value.length, start + e.x - (layout.current.box?.textX ?? 3))));
      return setFocus('prompt');
    }
    const row = e.y - promptTop - 1;
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
  const bottom = confirmReq ? confirmHeight(confirmReq) : commandRows(suggestions.length);
  const petState = { listening: Boolean(listening), address: listening ? `${listening.host}:${listening.port}` : '', port: listening?.port, count: list.length, open, refused, serious };
  const mood = moodFor({ state: petState, lastEntry: entries.at(-1) });
  const feeling = familyMood({ mood, state: petState, lastEntry: entries.at(-1) });
  useEffect(() => {
    if (config.familyMoods !== false) writeMood('lookout', feeling);
  }, [feeling.mood, feeling.reason, config.familyMoods]);
  // The top line, then the view, the activity, the prompt and its suggestions, then the status line.
  const top = topLine({
    face: FACES[mood],
    title: 'Lookout',
    views: viewTabs(tabCounts),
    view,
    context: headerContext({ cwd, env, listening, intercept: config.intercept === true, paused, count: list.length, findings, problem }),
    width: W,
    compact: true,
  });
  const mainH = Math.max(6, H - 1 - act.length - (busy ? 1 : 0) - bottom - 1);
  const viewActive = focus === 'view' && !overlay && !confirmReq;
  // The command box, over the view while the prompt has the keys (the kit's CommandBox).
  const cmdBox = commandBoxFor({ open: focus === 'prompt' && !confirmReq, width: W, height: H, count: suggestions.length });
  layout.current = {
    box: cmdBox,
    mainTop: 1,
    mainH,
    promptTop: promptRowFor(cmdBox, 1 + mainH + act.length + (busy ? 1 : 0)),
    sugCount: suggestions.length,
    tabs: top.tabs.map((t) => ({ id: t.id, from: t.x, to: t.x + t.width })),
  };

  const overlayActive = focus === 'view' && !confirmReq;
  const closeOverlay = () => queueMicrotask(ctx.closeOverlay);
  let main;
  if (overlay?.kind === 'help') {
    main = <HelpView sections={HELP_SECTIONS} start={overlay.start} ctx={ctx} width={W} height={mainH} active={overlayActive} onClose={closeOverlay} />;
  } else if (overlay?.kind === 'detail') {
    main = <DetailView key={viewerKey(overlay)} ex={overlay.ex} version={version} ctx={ctx} width={W} height={mainH} active={overlayActive} onClose={closeOverlay} />;
  } else if (overlay?.kind === 'data') {
    main = <DataViewer key={viewerKey(overlay)} title={overlay.title} text={overlay.text} ctx={ctx} width={W} height={mainH} active={overlayActive} onClose={closeOverlay} />;
  } else if (overlay) {
    main = <Viewer key={viewerKey(overlay)} title={overlay.title} text={overlay.text} ctx={ctx} width={W} height={mainH} active={overlayActive} onClose={closeOverlay} />;
  } else if (view === 'log') {
    main = <LogView entries={entries} ctx={ctx} width={W} height={mainH} active={viewActive} />;
  } else if (view === 'hosts') {
    main = <HostsView hosts={hostList} passThrough={config.passThrough ?? []} ctx={ctx} width={W} height={mainH} active={viewActive} />;
  } else if (view === 'security') {
    main = <SecurityView findings={findings} ctx={ctx} width={W} height={mainH} active={viewActive} />;
  } else if (view === 'setup') {
    main = <SetupView listening={listening} config={config} ctx={ctx} width={W} height={mainH} active={viewActive} />;
  } else {
    main = <RequestsView list={shown} total={list.length} filter={filter} listening={listening} paused={paused} ctx={ctx} width={W} height={mainH} active={viewActive} onCursor={(ex) => {
          selectedRef.current = ex;
        }} />;
  }

  const keys = focus === 'prompt'
      ? 'enter run · tab complete · ↑↓ pick or history · esc back'
      : overlay?.kind === 'help'
        ? 'j/k section · space scroll · / search · esc close'
        : overlay?.kind === 'detail'
          ? 's show credentials · d response body · r request body · h to Hail · t copy for Hail · / search · esc close'
          : overlay
            ? 'j/k scroll · space page · / search · y copy · esc close'
            : HINTS[view];
  const right = focus === 'prompt' ? '' : '/ commands · ! shell · , settings · ? help';
  // What the status line says beside the face: a flash, a sibling's news, the welcome until the first
  // command, else how Peep sees things. At the prompt its keys come first, so only a flash or a sibling.
  let bar = { face: FACES[mood], message: moodLine(mood, petState) };
  if (flash) bar = { face: FACES[mood], message: flash.text, news: true };
  else if (reaction) bar = { face: FACES[reaction.mood === 'happy' ? 'happy' : 'worried'], message: [{ text: reaction.text }, { text: '  esc', color: theme.dim }], news: true };
  else if (welcome)
    bar = update
      ? { face: FACES[mood], message: updateLine(update), tone: 'warn' }
      : { face: FACES[mood], message: welcomeLine('Lookout', VERSION, `${PET.name} the ${PET.kind} here. ${moodLine(mood, petState)}`) };

  return (
    <Box flexDirection="column" width={W} height={H}>
      <Row pointer={false} width={W} segments={top.segments} />
      <Box height={mainH} width={W}>
        {main}
      </Box>
      {act.map((segs, i) => (
        <Row key={i} pointer={false} width={W} segments={segs} />
      ))}
      {busy ? <Spinner label={progress ? `${busy.label} ${progress}` : busy.label} started={busy.started} width={W} /> : null}
      {confirmReq ? (
        confirmReq.secret ? (
          <SecretPrompt key={confirmReq.id} req={confirmReq} width={W} onDone={onConfirm} />
        ) : (
          <Confirm key={confirmReq.id} req={confirmReq} width={W} onDone={onConfirm} />
        )
      ) : (
        <PromptBox value={prompt.value} cursor={prompt.cursor} focused={focus === 'prompt'} width={W} modal items={suggestions} selected={sel} height={H} placeholder="Press / for commands, ! to run a shell command, ? for shortcuts" />
      )}
      <StatusLine {...bar} typing={focus === 'prompt'} keys={keys} right={right} width={W} />
    </Box>
  );
}
