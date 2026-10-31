import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdin } from 'ink';
import { basename } from 'node:path';
import * as a from '../actions.js';
import { COMMANDS, findCommand, suggestionsFor } from '../commands.js';
import { saveConfig } from '../config.js';
import { HELP } from '../help.js';
import { commandsSection, sectionFor } from '@fleet/kit/help-layout.js';
import { askHostToUpdate } from '@fleet/kit/hosted.js';
import { createChart } from '../iac.js';
import { summarize } from '../plan.js';
import { actionTone } from '../rows.js';
import { BULLET, theme } from '../theme.js';
import { fitSegments, stringWidth } from '@fleet/kit/text.js';
import { VERSION } from '../app.js';
import { useKeyTranslation, useTerminalSize } from '@fleet/kit/ui/hooks.js';
import { shortcutKey } from '@fleet/kit/keymap.js';
import { remember } from '@fleet/kit/folders.js';
import { Confirm, PromptBox, Row, SecretPrompt, Spinner, Suggestions, confirmHeight } from '@fleet/kit/ui/parts.jsx';
import { HelpView } from '@fleet/kit/ui/HelpView.jsx';
import { ChangesView } from './ChangesView.jsx';
import { StateView } from './StateView.jsx';
import { LogView } from './LogView.jsx';
import { Viewer } from './Viewer.jsx';
import { WELCOME_HEIGHT, Welcome } from './Pet.jsx';
import { FACES, moodFor } from '../pet.js';
import { decodeContext, logActivity, pastedLine, readMoods, writeMood } from '@fleet/kit/family.js';
import { familyMood, reactionTo } from '../moods.js';

const VIEWS = [
  { id: 'changes', label: 'Changes' },
  { id: 'drift', label: 'Drift' },
  { id: 'state', label: 'State' },
  { id: 'log', label: 'Log' },
];

const HINTS = {
  changes: '↵ what changes · a unchanged too · t for Splice · s app for Locker · y copy address · ctrl+r plan again',
  drift: '↵ what changed · t for Splice · s app for Locker · y copy address · /drift looks again',
  state: '↵ its values · t for Splice · y copy address',
  log: '↵ all its output · y copy it',
};

// The marks of a plan's summary in the header, worst first.
const SUMMARY = [['delete', '-'], ['replace', '±'], ['update', '~'], ['deploy', '~'], ['create', '+']];

const HELP_SECTIONS = [...HELP, commandsSection(COMMANDS)];
const DOUBLE_CLICK_MS = 400;
const firstLine = (s) => String(s ?? '').split('\n')[0];

function Header({ data, cwd, tool, width, loading, mood, problem }) {
  const segs = [
    { text: `${FACES[mood]} `, color: theme.accent, bold: true },
    { text: 'Chart', bold: true },
    { text: '  │  ', color: theme.border },
    { text: basename(cwd) || cwd, color: theme.dim },
    { text: `  ${tool}`, color: theme.dim },
  ];
  if (data?.plan) {
    const s = summarize(data.plan.changes);
    segs.push({ text: '  │  ', color: theme.border }, { text: data.source?.label ?? 'plan', color: theme.dim });
    const shown = SUMMARY.filter(([a]) => s[a]);
    if (!shown.length) segs.push({ text: '  no changes', color: theme.add });
    for (const [a, mark] of shown) segs.push({ text: `  ${mark}${s[a]}`, color: actionTone(a), bold: a === 'delete' || a === 'replace' });
  } else if (data?.found) segs.push({ text: '  │  ', color: theme.border }, { text: 'no plan yet', color: theme.dim });
  else if (loading) segs.push({ text: '  looking…', color: theme.dim });
  if (data?.drift?.length) segs.push({ text: `  ${data.drift.length} drifted`, color: theme.warn, bold: true });
  if (problem) segs.push({ text: '  │  ', color: theme.border }, { text: firstLine(problem), color: theme.warn });
  return <Row pointer={false} width={width} segments={segs} />;
}

/** The tabs' labels and the columns each one covers (`from` up to `to`), which clicks are matched against. */
function tabLabels(entries, data) {
  let x = 0;
  return VIEWS.map((v, i) => {
    let label = ` ${i + 1} ${v.label}`;
    const changing = data?.plan?.changes.filter((c) => !['noop', 'ignore'].includes(c.action)).length;
    if (v.id === 'changes' && changing) label += ` ${changing}`;
    if (v.id === 'drift' && data?.drift?.length) label += ` ${data.drift.length}`;
    if (v.id === 'log' && entries.length) label += ` ${entries.length}`;
    label += ' ';
    const from = x;
    x += stringWidth(label) + 1;
    return { id: v.id, label, from, to: from + stringWidth(label) };
  });
}

function Tabs({ view, entries, data, width }) {
  const segs = [];
  for (const t of tabLabels(entries, data)) {
    const on = t.id === view;
    segs.push({ text: t.label, bg: on ? theme.accent : undefined, color: on ? theme.ink : theme.dim, bold: on }, { text: ' ' });
  }
  return <Row pointer={false} width={width} segments={segs} />;
}

// The last two results, Claude Code style: "● terraform plan infra" then "  ⎿  output".
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

// `provider` is iac.js's (demo.js's for --demo and the tests); `cwd` the folder looked at first. `copy`
// puts text on the clipboard (cli.jsx's; tests pass a stub), `openUrl` opens the browser.
// `checkUpdate` and `installUpdate` come only in the downloaded builds, so tests and checkouts never go
// online for them or replace anything.
export function App({ config: initialConfig, provider = createChart(), cwd: startDir = process.cwd(), moodEvery = 30_000, openUrl, setTitle, mouse, copy, checkUpdate, installUpdate }) {
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize();
  const [config, setConfigState] = useState(initialConfig);
  const [data, setDataState] = useState(null);
  const [cwd, setCwdState] = useState(startDir);
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState(null);
  const [view, setView] = useState('changes');
  const [showAll, setShowAll] = useState(false);
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

  // A sibling's mood Plot reacts to (family.js's readMoods, every `moodEvery` ms): one line until esc.
  const [reaction, setReaction] = useState(null);
  const reactionRef = useRef(null);
  reactionRef.current = reaction;
  const seenMoods = useRef(new Set());
  useEffect(() => {
    if (config.familyMoods === false || !moodEvery) return setReaction(null);
    const look = () => {
      const r = reactionTo(readMoods('chart'), seenMoods.current);
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
    if (configRef.current.familyMoods !== false) logActivity('chart', { text, kind, project: cwdRef.current });
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
      setConfig((c) => ({ ...c, recent: remember(c.recent ?? [], dir) }));
    },
    setData,
    task,
    note,
    confirm,
    prefill,
    // A word on how far a task has got, beside the spinner.
    progress: (text) => alive.current && setProgress(text),
    logActivity: familyLog,
    refresh: () => a.again(ctx),
    // Settings change through App's copy, the only one written to disk (ctx.config reads it).
    setConfig,
    setView,
    toggleAll: () => setShowAll((x) => !x),
    openUrl: (url) => (openUrl ? openUrl(url) : note(`Open ${url}`)),
    // /update: asks for the latest release now, whatever the daily check last said, and installs it.
    updateNow: () => {
      if (askHostToUpdate()) return note('Asked Fleet to look for a new version of the whole fleet.');
      if (!checkUpdate) return note(`This Chart (${VERSION}) runs from a checkout: git pull updates it.`);
      if (update?.state === 'installing') return note(`Chart ${update.latest} is being installed already.`);
      if (update?.state === 'installed') return note(`Chart ${update.latest} is installed. It starts the next time you open Chart.`);
      const said = (text) => ({ stdout: text, stderr: '' });
      return task(
        'Looking for a new version of Chart',
        async () => {
          const { checked, newer } = await checkUpdate(null);
          setConfig((c) => ({ ...c, lastUpdateCheck: checked }));
          if (!newer) return said(`Chart ${VERSION} is the latest version.`);
          if (!installUpdate) {
            setUpdate({ ...checked, state: 'out' });
            return said(`Chart ${checked.latest} is out (you have ${VERSION}). Download it from ${checked.url}`);
          }
          setUpdate({ ...checked, state: 'installing' });
          try {
            await installUpdate(checked.latest);
          } catch (e) {
            setUpdate({ ...checked, state: 'out' });
            throw new Error(`Chart ${checked.latest} is out, but it couldn't be installed: ${firstLine(e.message)}\nDownload it from ${checked.url}`);
          }
          setUpdate({ ...checked, state: 'installed' });
          return said(`Chart ${checked.latest} is installed. It starts the next time you open Chart.`);
        },
        { label: 'Updating Chart' },
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
  };

  // Look at the folder on opening (a plan only when asked: it can take a while, and it signs in), then
  // look for a newer release.
  useEffect(() => {
    (async () => {
      await a.look(ctx);
      starting.current = false;
      if (!alive.current) return;
      if (checkUpdate && configRef.current.checkForUpdates !== false) {
        checkUpdate(configRef.current.lastUpdateCheck).then(
          ({ checked, newer }) => {
            setConfig((c) => ({ ...c, lastUpdateCheck: checked }));
            if (!newer) return;
            const outNote = (why = '') => note(`Chart ${checked.latest} is out (you have ${VERSION})${why}.\nDownload it from ${checked.url}`);
            if (!installUpdate || configRef.current.autoUpdate === false) {
              setUpdate({ ...checked, state: 'out' });
              return outNote();
            }
            // In the background, without the spinner: nothing waits on it, and it only counts from the next start.
            setUpdate({ ...checked, state: 'installing' });
            installUpdate(checked.latest).then(
              () => {
                setUpdate({ ...checked, state: 'installed' });
                note(`Chart ${checked.latest} is installed. It starts the next time you open Chart.`);
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
  const title = `${basename(cwd) || cwd} · ${VIEWS.find((v) => v.id === view).label} — Chart`;
  useEffect(() => {
    setTitle?.(title);
  }, [title]);

  const suggestions = focus === 'prompt' && !confirmReq ? suggestionsFor(prompt.value, { data, cwd }) : [];
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
    const items = suggestionsFor(value, { data: dataRef.current, cwd: cwdRef.current });
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
    const row = e.y - promptTop - 3;
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
  const bottom = confirmReq ? confirmHeight(confirmReq) : 3 + suggestions.length;
  // What the pet and the welcome box read: the plan with the latest drift (a refresh-only plan's, when it came after).
  const told = data ? { ...data, plan: data.plan ? { ...data.plan, drift: data.drift ?? data.plan.drift } : data.drift?.length ? { tool: 'terraform', changes: [], drift: data.drift, outputs: [] } : null } : null;
  const mood = moodFor({ data: told, busy, lastEntry: entries.at(-1) });
  // How Plot feels, for the siblings (family.js's writeMood), whenever that changes.
  const feeling = familyMood({ mood, data: told, lastEntry: entries.at(-1), busy });
  useEffect(() => {
    if (config.familyMoods !== false) writeMood('chart', feeling);
  }, [feeling.mood, feeling.reason, config.familyMoods]);
  // The welcome box only appears when the terminal has room for it next to a useful view.
  const showWelcome = welcome && H >= 28;
  const reacting = reaction ? 1 : 0;
  const mainH = Math.max(6, H - 2 - reacting - act.length - (busy ? 1 : 0) - bottom - 1 - (showWelcome ? WELCOME_HEIGHT : 0));
  const viewActive = focus === 'view' && !overlay && !confirmReq;
  layout.current = {
    mainTop: 2,
    mainH,
    promptTop: 2 + mainH + (showWelcome ? WELCOME_HEIGHT : 0) + reacting + act.length + (busy ? 1 : 0),
    sugCount: suggestions.length,
    tabs: tabLabels(entries, data),
  };

  let main;
  if (overlay?.kind === 'help') {
    main = <HelpView sections={HELP_SECTIONS} start={overlay.start} ctx={ctx} width={W} height={mainH} active={focus === 'view' && !confirmReq} onClose={() => queueMicrotask(ctx.closeOverlay)} />;
  } else if (overlay) {
    main = <Viewer key={viewerKey(overlay)} title={overlay.title} text={overlay.text} ctx={ctx} width={W} height={mainH} active={focus === 'view' && !confirmReq} onClose={() => queueMicrotask(ctx.closeOverlay)} />;
  } else if (view === 'log') {
    main = <LogView entries={entries} ctx={ctx} width={W} height={mainH} active={viewActive} />;
  } else if (view === 'state') {
    main = <StateView state={data?.state} ctx={ctx} width={W} height={mainH} active={viewActive} />;
  } else if (view === 'drift') {
    const driftEmpty = data?.drift ? 'Nothing changed outside the code.' : data?.plan?.tool === 'bicep' ? "A what-if doesn't tell drift from change: every Modify is in Changes." : '/drift looks for what changed outside Terraform (a refresh-only plan); /plan does too.';
    main = <ChangesView key="drift" changes={data?.drift ?? []} drifted empty={driftEmpty} ctx={ctx} width={W} height={mainH} active={viewActive} />;
  } else {
    const found = data?.found;
    const changesEmpty = data?.plan ? 'Nothing to change: the infrastructure matches.' : !found ? 'Looking at the folder…' : found.tfDirs.length ? '/plan asks terraform what it would change (nothing is applied).' : found.bicep.length ? `/whatif ${found.bicep[0]} --rg <resource group> asks Azure what deploying it would change.` : 'No .tf or .bicep files here: /move to an infrastructure folder, or /open a saved plan.';
    main = <ChangesView key="changes" changes={data?.plan?.changes ?? []} empty={changesEmpty} hint={data?.plan?.outputs?.length ? `${data.plan.outputs.length} outputs change` : ''} showAll={showAll} ctx={ctx} width={W} height={mainH} active={viewActive} />;
  }

  const left = flash
    ? flash.text
    : focus === 'prompt'
      ? 'enter run · tab complete · ↑↓ pick or history · esc back'
      : overlay?.kind === 'help'
        ? 'j/k section · space scroll · / search · esc close'
        : overlay
          ? 'j/k scroll · space page · / search · y copy · esc close'
          : HINTS[view];
  const right = focus === 'prompt' ? '' : '  / commands · ! shell · , settings · ? help';

  return (
    <Box flexDirection="column" width={W} height={H}>
      <Header data={data} cwd={cwd} tool={config.terraform ?? 'terraform'} width={W} loading={loading} mood={mood} problem={problem} />
      <Tabs view={view} entries={entries} data={data} width={W} />
      <Box height={mainH} width={W}>
        {main}
      </Box>
      {showWelcome ? <Welcome mood={mood} data={told} width={W} update={update} problem={null} /> : null}
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
      {busy ? <Spinner label={progress ? `${busy.label} ${progress}` : busy.label} started={busy.started} width={W} /> : null}
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
      <Row
        pointer={false}
        width={W}
        segments={[...fitSegments([{ text: `  ${left}`, color: theme.dim }], W - stringWidth(right)), { text: right, color: theme.dim }]}
      />
    </Box>
  );
}
