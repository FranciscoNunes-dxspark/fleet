import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdin } from 'ink';
import { basename } from 'node:path';
import * as a from '../actions.js';
import { COMMANDS, findCommand, suggestionsFor } from '../commands.js';
import { saveConfig } from '../config.js';
import { HELP } from '../help.js';
import { commandsSection, sectionFor } from '@fleet/kit/help-layout.js';
import { askHostToUpdate } from '@fleet/kit/hosted.js';
import { createBallast } from '../provider.js';
import { totals } from '../build.js';
import { checkBudgets } from '../budgets.js';
import { duplicates } from '../modules.js';
import { formatBytes, formatDelta, sizeIn } from '../sizes.js';
import { BULLET, theme } from '../theme.js';
import { VERSION } from '../app.js';
import { useEnvironment, useKeyTranslation, useTerminalSize } from '@fleet/kit/ui/hooks.js';
import { recordCommand } from '@fleet/kit/recording.js';
import { shortcutKey } from '@fleet/kit/keymap.js';
import { remember } from '@fleet/kit/folders.js';
import { Confirm, PromptBox, Row, SecretPrompt, Spinner, commandBoxFor, commandBoxHit, commandRows, confirmHeight, promptRowFor } from '@fleet/kit/ui/parts.jsx';
import { StatusLine, topLine, welcomeLine } from '@fleet/kit/ui/shell.jsx';
import { HelpView } from '@fleet/kit/ui/HelpView.jsx';
import { ChunksView } from './ChunksView.jsx';
import { ModulesView } from './ModulesView.jsx';
import { DuplicatesView } from './DuplicatesView.jsx';
import { CompareView } from './CompareView.jsx';
import { LogView } from './LogView.jsx';
import { Viewer } from './Viewer.jsx';
import { updateLine } from './Pet.jsx';
import { FACES, PET, moodFor, moodLine } from '../pet.js';
import { decodeContext, logActivity, pastedLine, readMoods, writeMood } from '@fleet/kit/family.js';
import { familyMood, reactionTo } from '../moods.js';

const VIEWS = [
  { id: 'chunks', label: 'Chunks' },
  { id: 'modules', label: 'Modules' },
  { id: 'duplicates', label: 'Duplicates' },
  { id: 'compare', label: 'Compare' },
  { id: 'log', label: 'Log' },
];

const HINTS = {
  chunks: '↵ what is in it · s sort · c budgets · y copy path · /build · /security',
  modules: '↵ open · ← close · c next chunk · p package · w /why for Bilge · t for Splice · y copy',
  duplicates: '↵ each copy · p package · w /why for Bilge · y copy name',
  compare: '↵ details · b last/main · m markdown · p package · w /why for Bilge · y copy headline',
  log: '↵ all its output · y copy it',
};

const HELP_SECTIONS = [...HELP, commandsSection(COMMANDS)];
const DOUBLE_CLICK_MS = 400;
const firstLine = (s) => String(s ?? '').split('\n')[0];

// What the top line says at its right, most important first, as it drops whole parts from the end
// when the line is narrow: what went wrong, the environment, what is over budget, the change against
// the base, the build's weight, the project.
function headerContext({ build, measure, over, compare, cwd, env, loading, problem }) {
  const parts = [];
  if (problem) parts.push([{ text: firstLine(problem), color: theme.warn }]);
  // The project's environment, when it names them: red and bold for a production one.
  if (env) parts.push([{ text: env.prod ? `${env.name} (production)` : env.name, color: env.prod ? theme.del : theme.dim, bold: env.prod, need: true }]);
  if (build?.chunks.length) {
    if (over) parts.push([{ text: `${over} over budget`, color: theme.del, bold: true, need: true }]);
    const t = compare?.result?.total;
    if (t) parts.push([{ text: `${t.delta ? formatDelta(t.delta) : '±0'} vs ${compare.base === 'last' ? 'last' : compare.name}`, color: t.delta > 0 ? theme.warn : t.delta < 0 ? theme.add : theme.dim }]);
    parts.push([{ text: `${formatBytes(sizeIn(totals(build.chunks), measure))} ${measure}`, bold: true }, { text: ` in ${build.chunks.length} file${build.chunks.length === 1 ? '' : 's'}`, color: theme.dim }]);
  } else if (build) parts.push([{ text: 'nothing built to read', color: theme.dim }]);
  else if (loading) parts.push([{ text: 'reading…', color: theme.dim }]);
  parts.push([{ text: basename(cwd) || cwd, color: theme.dim }]);
  return parts.flatMap((p, i) => (i ? [{ text: '  ' }, ...p] : p));
}

// The views in the top line, the digit that picks each before it, the duplicates' and the log's counts after.
const viewTabs = (entries, dupes) =>
  VIEWS.map((v, i) => ({
    id: v.id,
    key: i + 1,
    label: v.label,
    count: v.id === 'duplicates' ? dupes || 0 : v.id === 'log' ? entries.length : 0,
    countColor: theme.dim,
  }));

// The last two results, Claude Code style: "● audit 120 packages" then "  ⎿  output".
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

// `provider` is provider.js's (demo.js's for --demo and the tests); `cwd` the folder read first. `copy`
// puts text on the clipboard (cli.jsx's; tests pass a stub), `openUrl` opens the browser.
// `checkUpdate` and `installUpdate` come only in the downloaded builds, so tests and checkouts never go
// online for them or replace anything.
export function App({ config: initialConfig, provider = createBallast(), cwd: startDir = process.cwd(), moodEvery = 30_000, openUrl, setTitle, mouse, copy, checkUpdate, installUpdate }) {
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize();
  const [config, setConfigState] = useState(initialConfig);
  const [data, setDataState] = useState(null);
  // The comparison on show ({ base, name, run?, result?, missing? }) and what it's against ('last', 'main', a ref).
  const [compare, setCompareState] = useState(null);
  const compareRef = useRef(null);
  const compareBaseRef = useRef(initialConfig.compareWith ?? 'last');
  // The last /security's result, until Ballast reads another folder.
  const securityRef = useRef(null);
  // Advisories asked of OSV this session, name@version → list.
  const advisories = useRef(new Map());
  const [cwd, setCwdState] = useState(startDir);
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState(null);
  const [view, setView] = useState('chunks');
  // The chunk the Modules view shows, or null for all of them.
  const [modulesFile, setModulesFile] = useState(null);
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
  // The project's environment (the kit's environments.js), followed as it's switched here or in another
  // app; a production one draws the frames red.
  const env = useEnvironment('ballast', cwd);
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

  // A sibling's mood Plod reacts to (family.js's readMoods, every `moodEvery` ms): one line until esc.
  const [reaction, setReaction] = useState(null);
  const reactionRef = useRef(null);
  reactionRef.current = reaction;
  const seenMoods = useRef(new Set());
  useEffect(() => {
    if (config.familyMoods === false || !moodEvery) return setReaction(null);
    const look = () => {
      const r = reactionTo(readMoods('ballast'), seenMoods.current);
      if (!r) return;
      seenMoods.current.add(r.key);
      setReaction(r);
    };
    look();
    const t = setInterval(look, moodEvery);
    return () => clearInterval(t);
  }, [config.familyMoods, moodEvery]);

  // Async actions read the latest state through refs, not through stale closures.
  const dataRef = useRef(null);
  const cwdRef = useRef(startDir);
  const busyRef = useRef(null);
  const configRef = useRef(config);
  const promptRef = useRef(prompt);
  const confirmRef = useRef(null);
  const focusRef = useRef('view');
  const overlayRef = useRef(null);
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

  const setData = (next) => {
    dataRef.current = typeof next === 'function' ? next(dataRef.current) : next;
    setDataState(dataRef.current);
  };
  const setCompare = (next) => {
    compareRef.current = next;
    setCompareState(next);
  };
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

  // The measure (the setting, else the project's budgets file's, else gzip) and the budgets' verdicts,
  // worked out again only when the build, the budgets or the measure change.
  const measureOf = () => configRef.current.measure ?? dataRef.current?.budgets?.measure ?? 'gzip';
  const derived = useRef({});
  const derive = () => {
    const d = dataRef.current;
    const measure = measureOf();
    const was = derived.current;
    if (was.build === d?.build && was.budgets === d?.budgets && was.measure === measure) return was;
    const checks = d?.build ? checkBudgets(d.build.chunks, d.budgets?.budgets ?? [], measure) : [];
    derived.current = { build: d?.build, budgets: d?.budgets, measure, checks, dupes: d?.build ? duplicates(d.build.chunks).length : 0 };
    return derived.current;
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
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const familyLog = (text, kind = 'info') => {
    if (configRef.current.familyMoods !== false) logActivity('ballast', { text, kind, project: cwdRef.current });
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
    // The reading on opening leaves the welcome box up; anything after puts it away.
    if (!starting.current) setWelcome(false);
    try {
      const result = await start(controller.signal);
      const { stdout = '', stderr = '' } = result;
      const out = [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join('\n');
      lastOutput.current = { title, text: out || '(no output)' };
      updateEntry(id, { status: 'ok', lines: out ? out.split('\n') : ['Done'] });
      setProblem(null);
      // What changed a project goes in the family's activity log (/timeline in the others).
      if (activity) familyLog(activity, 'change');
      return { ok: true, out, result };
    } catch (error) {
      const cancelled = error.cancelled || controller.signal.aborted;
      lastOutput.current = { title, text: error.message };
      updateEntry(id, { status: 'error', lines: cancelled ? ['Cancelled'] : error.message.split('\n') });
      return { ok: false, error };
    } finally {
      busyRef.current = null;
      setBusy(null);
      if (alive.current) setLoading(false);
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
      get data() {
        return dataRef.current;
      },
      get config() {
        return configRef.current;
      },
      // gzip, brotli or raw: the setting, else the budgets file's, else gzip.
      get measure() {
        return derive().measure;
      },
      // Each budget against the build (budgets.js's checkBudgets).
      get checks() {
        return derive().checks;
      },
      // { base, name, run?, result?, missing? }, or null before anything was compared.
      get compare() {
        return compareRef.current;
      },
      // The last /security's result ({ dirs, files, findings }), or null.
      get security() {
        return securityRef.current;
      },
      // name@version → OSV's advisories, asked once a session.
      get advisories() {
        return advisories.current;
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
    cwd: () => cwdRef.current,
    // /move: another folder, remembered among the recent ones.
    moveTo: (dir) => {
      cwdRef.current = dir;
      setCwdState(dir);
      setData(null);
      setCompare(null);
      securityRef.current = null;
      setModulesFile(null);
      setConfig((c) => ({ ...c, recent: remember(c.recent ?? [], dir) }));
    },
    setData,
    setCompare,
    setSecurity: (s) => {
      securityRef.current = s;
    },
    // What /compare compares with when nothing else is said: the last one asked for.
    compareBase: () => compareBaseRef.current,
    setCompareBase: (b) => {
      compareBaseRef.current = b;
    },
    showModules: (file) => {
      setModulesFile(file ?? null);
      setView('modules');
    },
    task,
    note,
    confirm,
    prefill,
    // A word on how far a task has got, beside the spinner.
    progress: (text) => alive.current && setProgress(text),
    logActivity: familyLog,
    // ctrl+r: the build read again, and compared again.
    refresh: () => a.read(ctx),
    // Settings change through App's copy, the only one written to disk (ctx.config reads it).
    setConfig,
    setView,
    openUrl: (url) => (openUrl ? openUrl(url) : note(`Open ${url}`)),
    // /update: asks for the latest release now, whatever the daily check last said, and installs it.
    updateNow: () => {
      if (askHostToUpdate()) return note('Asked Fleet to look for a new version of the whole fleet.');
      if (!checkUpdate) return note(`This Ballast (${VERSION}) runs from a checkout: git pull updates it.`);
      if (update?.state === 'installing') return note(`Ballast ${update.latest} is being installed already.`);
      if (update?.state === 'installed') return note(`Ballast ${update.latest} is installed. It starts the next time you open Ballast.`);
      const said = (text) => ({ stdout: text, stderr: '' });
      return task(
        'Looking for a new version of Ballast',
        async () => {
          const { checked, newer } = await checkUpdate(null);
          setConfig((c) => ({ ...c, lastUpdateCheck: checked }));
          if (!newer) return said(`Ballast ${VERSION} is the latest version.`);
          if (!installUpdate) {
            setUpdate({ ...checked, state: 'out' });
            return said(`Ballast ${checked.latest} is out (you have ${VERSION}). Download it from ${checked.url}`);
          }
          setUpdate({ ...checked, state: 'installing' });
          try {
            await installUpdate(checked.latest);
          } catch (e) {
            setUpdate({ ...checked, state: 'out' });
            throw new Error(`Ballast ${checked.latest} is out, but it couldn't be installed: ${firstLine(e.message)}\nDownload it from ${checked.url}`);
          }
          setUpdate({ ...checked, state: 'installed' });
          return said(`Ballast ${checked.latest} is installed. It starts the next time you open Ballast.`);
        },
        { label: 'Updating Ballast' },
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
    closeOverlay: () => setOverlay(null),
    showHelp: () => setOverlay({ kind: 'help', start: sectionFor(HELP_SECTIONS, view) }),
    showLast: () => (lastOutput.current ? setOverlay({ ...lastOutput.current }) : note('No command has run yet.')),
  });

  // One line as typed at the prompt: a shell command after !, else a slash command. Resolves false when it failed.
  const runLine = async (text) => {
    try {
      if (text.startsWith('!')) return (await a.raw(ctx, text.slice(1).trim())) !== false;
      // A sibling's context pasted alone is /take's.
      if (decodeContext(text)) return (await a.take(ctx, text)) !== false;
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
    recordCommand('ballast', decodeContext(text) ? `/take ${text}` : text);
  };

  // Read the build on opening (asking to build it with stats when there's nothing), then look for a newer release.
  useEffect(() => {
    (async () => {
      await a.read(ctx);
      starting.current = false;
      if (!alive.current) return;
      if (checkUpdate && configRef.current.checkForUpdates !== false) {
        checkUpdate(configRef.current.lastUpdateCheck).then(
          ({ checked, newer }) => {
            setConfig((c) => ({ ...c, lastUpdateCheck: checked }));
            if (!newer) return;
            const outNote = (why = '') => note(`Ballast ${checked.latest} is out (you have ${VERSION})${why}.\nDownload it from ${checked.url}`);
            if (!installUpdate || configRef.current.autoUpdate === false) {
              setUpdate({ ...checked, state: 'out' });
              return outNote();
            }
            // In the background, without the spinner: nothing waits on it, and it only counts from the next start.
            setUpdate({ ...checked, state: 'installing' });
            installUpdate(checked.latest).then(
              () => {
                setUpdate({ ...checked, state: 'installed' });
                note(`Ballast ${checked.latest} is installed. It starts the next time you open Ballast.`);
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
  const title = `${basename(cwd) || cwd} · ${VIEWS.find((v) => v.id === view).label} — Ballast`;
  useEffect(() => {
    setTitle?.(title);
  }, [title]);

  const { measure, checks, dupes } = derive();
  const suggestions = focus === 'prompt' && !confirmReq ? suggestionsFor(prompt.value, { data, config, cwd }) : [];
  const sel = Math.min(sugIndex, Math.max(0, suggestions.length - 1));

  // Uppercase shortcuts are alt+letter (caps lock can't fire them); typing in a prompt or a confirm is left alone.
  const sendKey = useKeyTranslation((input) => {
    // The help's search takes letters as they are typed.
    if (focusRef.current === 'view' && !confirmRef.current && overlayRef.current?.kind !== 'help') return shortcutKey(input);
    return input;
  });
  void sendKey;

  // Line editing in the prompt.
  const promptKeys = (input, key) => {
    const { value, cursor } = promptRef.current;
    const items = suggestionsFor(value, { data: dataRef.current, config: configRef.current, cwd: cwdRef.current });
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
    if (key.ctrl && input === 'r') return ctx.refresh();
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
      const i = VIEWS.findIndex((v) => v.id === view);
      return setView(VIEWS[(i + (key.shift ? VIEWS.length - 1 : 1)) % VIEWS.length].id);
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
      // Whatever is open over the view closes: a click on a tab should never do nothing.
      if (overlayRef.current) ctx.closeOverlay();
      setFocus('view');
      return setView(tab.id);
    }
    if (!inBox && e.y >= mainTop && e.y < mainTop + mainH) {
      // Like esc, a click on the view leaves the prompt's text for later.
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
    const row = e.y - (layout.current.box?.items ?? promptTop + 1);
    if (row >= 0 && row < sugCount) {
      setSugIndex(row);
      // As ↵ would, on the suggestion under the pointer.
      if (e.double) promptKeys('', { return: true });
    }
  };
  const mouseRef = useRef(onMouse);
  mouseRef.current = onMouse;
  useEffect(() => mouse?.subscribe((e) => mouseRef.current(e)), [mouse]);
  // Drags that start where the component on screen selects for itself skip the screen selection (none here yet).
  useEffect(() => mouse?.claimDrags?.(() => false), [mouse]);

  // Layout: everything is sized to the terminal, one row short of it so Ink never clears the screen.
  const W = columns;
  const H = Math.max(12, rows - 1);
  // esc hides the activity lines; the Log view keeps them all.
  const act = activityRows(entries.filter((e) => e.shown !== false));
  const bottom = confirmReq ? confirmHeight(confirmReq) : commandRows(suggestions.length);
  // What the pet and the welcome box read: the build, its weight and what is over budget.
  const build = data?.build ?? null;
  const overList = checks.filter((b) => b.over);
  const total = build ? sizeIn(totals(build.chunks), measure) : null;
  const told = { build, over: overList.length, total, measure, compared: compare?.result ? `${compare.result.headline} against ${compare.base === 'last' ? 'the last build' : compare.name}` : null };
  const mood = moodFor({ build, over: overList.length, busy, lastEntry: entries.at(-1) });
  // How Plod feels, for the siblings (family.js's writeMood), whenever that changes.
  const feeling = familyMood({ mood, build, over: overList, budgeted: checks.length > 0, total, measure, lastEntry: entries.at(-1), busy });
  useEffect(() => {
    if (config.familyMoods !== false) writeMood('ballast', feeling);
  }, [feeling.mood, feeling.reason, config.familyMoods]);
  // The top line, then the view, the activity, the prompt and its suggestions, then the status line.
  const top = topLine({
    face: FACES[mood],
    title: 'Ballast',
    views: viewTabs(entries, dupes),
    view,
    context: headerContext({ build, measure, over: overList.length, compare, cwd, env, loading, problem }),
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

  let main;
  if (overlay?.kind === 'help') {
    main = <HelpView sections={HELP_SECTIONS} start={overlay.start} ctx={ctx} width={W} height={mainH} active={focus === 'view' && !confirmReq} onClose={() => queueMicrotask(ctx.closeOverlay)} />;
  } else if (overlay) {
    main = <Viewer key={viewerKey(overlay)} title={overlay.title} text={overlay.text} ctx={ctx} width={W} height={mainH} active={focus === 'view' && !confirmReq} onClose={() => queueMicrotask(ctx.closeOverlay)} />;
  } else if (view === 'log') {
    main = <LogView entries={entries} ctx={ctx} width={W} height={mainH} active={viewActive} />;
  } else if (view === 'modules') {
    main = <ModulesView build={build} file={modulesFile} measure={measure} ctx={ctx} width={W} height={mainH} active={viewActive} />;
  } else if (view === 'duplicates') {
    main = <DuplicatesView build={build} measure={measure} ctx={ctx} width={W} height={mainH} active={viewActive} />;
  } else if (view === 'compare') {
    main = <CompareView compare={compare} measure={measure} ctx={ctx} width={W} height={mainH} active={viewActive} />;
  } else {
    main = <ChunksView build={build} checks={checks} measure={measure} ctx={ctx} width={W} height={mainH} active={viewActive} />;
  }

  const keys = focus === 'prompt'
      ? 'enter run · tab complete · ↑↓ pick or history · esc back'
      : overlay?.kind === 'help'
        ? 'j/k section · space scroll · / search · esc close'
        : overlay
          ? 'j/k scroll · space page · / search · y copy · esc close'
          : HINTS[view];
  const right = focus === 'prompt' ? '' : '/ commands · ! shell · , settings · ? help';
  // What the status line says beside the face: a flash, a sibling's news, the welcome until the first
  // command, else how Plod sees the build.
  let said = { face: FACES[mood], message: moodLine(told) };
  if (flash) said = { face: FACES[mood], message: flash.text, news: true };
  else if (reaction) said = { face: FACES[reaction.mood === 'happy' ? 'happy' : 'worried'], message: [{ text: reaction.text }, { text: '  esc', color: theme.dim }], news: true };
  else if (!build && problem) said = { face: FACES[mood], message: problem, tone: 'warn' };
  else if (welcome && update) said = { face: FACES[mood], message: updateLine(update), tone: 'warn' };
  else if (welcome) said = { face: FACES[mood], message: welcomeLine('Ballast', VERSION, `${PET.name} the ${PET.kind} here. ${moodLine(told)}`) };

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
      <StatusLine {...said} typing={focus === 'prompt'} keys={keys} right={right} width={W} />
    </Box>
  );
}
