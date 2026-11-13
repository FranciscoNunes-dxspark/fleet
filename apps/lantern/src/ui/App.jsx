import React, { useEffect, useRef, useState } from 'react';
import { Box, useApp, useInput, useStdin } from 'ink';
import { basename } from 'node:path';
import * as a from '../actions.js';
import { COMMANDS, findCommand, suggestionsFor } from '../commands.js';
import { saveConfig } from '../config.js';
import { HELP } from '../help.js';
import { commandsSection, sectionFor } from '@fleet/kit/help-layout.js';
import { askHostToUpdate } from '@fleet/kit/hosted.js';
import { countFindings } from '@fleet/kit/findings.js';
import { createLantern } from '../provider.js';
import { addRun, loadHistory, saveHistory } from '../history.js';
import { withoutIgnored } from '../security.js';
import { severityTone } from '../rows.js';
import { BULLET, theme } from '../theme.js';
import { VERSION } from '../app.js';
import { useEnvironment, useKeyTranslation, useTerminalSize } from '@fleet/kit/ui/hooks.js';
import { recordCommand } from '@fleet/kit/recording.js';
import { shortcutKey } from '@fleet/kit/keymap.js';
import { remember } from '@fleet/kit/folders.js';
import { Confirm, PromptBox, Row, SecretPrompt, Spinner, commandBoxFor, commandBoxHit, commandRows, confirmHeight, promptRowFor } from '@fleet/kit/ui/parts.jsx';
import { StatusLine, topLine, welcomeLine } from '@fleet/kit/ui/shell.jsx';
import { HelpView } from '@fleet/kit/ui/HelpView.jsx';
import { PagesView } from './PagesView.jsx';
import { FindingsView } from './FindingsView.jsx';
import { CompareView } from './CompareView.jsx';
import { WaterfallView } from './WaterfallView.jsx';
import { DomainsView } from './DomainsView.jsx';
import { LogView } from './LogView.jsx';
import { Viewer } from './Viewer.jsx';
import { updateLine } from './Pet.jsx';
import { FACES, PET, moodFor, moodLine } from '../pet.js';
import { decodeContext, logActivity, pastedLine, readMoods, writeMood } from '@fleet/kit/family.js';
import { familyMood, reactionTo } from '../moods.js';

const VIEWS = [
  { id: 'pages', label: 'Pages' },
  { id: 'findings', label: 'Findings' },
  { id: 'compare', label: 'Compare' },
  { id: 'waterfall', label: 'Waterfall' },
  { id: 'domains', label: 'Domains' },
  { id: 'log', label: 'Log' },
];

const HINTS = {
  pages: '↵ findings · a audit · alt+a all · s security · c compare · w waterfall · o open · t copy page · y copy URL',
  findings: '↵ details · f category · s severity · x ignore · o help · y copy selector',
  compare: 'e other environment · p previous run · a audit both · y copy',
  waterfall: '↵ to Hail · l details · o open · y copy URL',
  domains: '↵ details · r check again · y copy host',
  log: '↵ all its output · y copy it',
};

const HELP_SECTIONS = [...HELP, commandsSection(COMMANDS)];
const DOUBLE_CLICK_MS = 400;
const firstLine = (s) => String(s ?? '').split('\n')[0];

// What the top line says at its right: the folder, the environment, the page and what its audit found,
// and a missing Chrome.
function headerContext({ page, result, cwd, env, chrome }) {
  const segs = [];
  const sep = () => segs.push({ text: '  ' });
  if (chrome === null) segs.push({ text: 'no Chrome found', color: theme.warn, need: true }), sep();
  if (page) {
    segs.push({ text: page.url, color: theme.dim });
    if (result) {
      const shown = ['critical', 'high', 'medium', 'low'].filter((s) => result.counts[s]);
      if (!shown.length) segs.push({ text: '  nothing found', color: theme.add });
      for (const s of shown) segs.push({ text: `  ${result.counts[s]} ${s}`, color: severityTone(s), bold: s === 'critical' || s === 'high' });
    } else segs.push({ text: '  not audited', color: theme.dim });
    sep();
  }
  if (env) segs.push({ text: env.prod ? `${env.name} (production)` : env.name, color: env.prod ? theme.del : theme.dim, bold: env.prod, need: env.prod }), sep();
  segs.push({ text: basename(cwd) || cwd, color: theme.dim });
  return segs;
}

// The views in the top line, the digit that picks each before it and its count after it.
const viewTabs = (entries, counts) =>
  VIEWS.map((v, i) => ({ id: v.id, key: i + 1, label: v.label, count: (counts[v.id] || 0) + (v.id === 'log' ? entries.length : 0), countColor: theme.dim }));

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

const viewerKeys = new WeakMap();
let viewerCount = 0;
const viewerKey = (overlay) => {
  if (!viewerKeys.has(overlay)) viewerKeys.set(overlay, ++viewerCount);
  return viewerKeys.get(overlay);
};

// `provider` is provider.js's (demo.js's for --demo and the tests); `cwd` the folder whose pages are read.
// `copy` puts text on the clipboard, `openUrl` opens the browser. `checkUpdate` and `installUpdate` come
// only in the downloaded builds.
export function App({ config: initialConfig, provider = createLantern(), cwd: startDir = process.cwd(), moodEvery = 30_000, openUrl, setTitle, mouse, copy, checkUpdate, installUpdate }) {
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize();
  const [config, setConfigState] = useState(initialConfig);
  const [cwd, setCwdState] = useState(startDir);
  const [pages, setPagesState] = useState([]);
  const [hosts, setHostsState] = useState([]);
  const [selected, setSelectedState] = useState(0);
  // The last audits of each page (history.js), this session's and the ones kept from before.
  const [history, setHistoryState] = useState(() => loadHistory());
  const [domainResults, setDomainsState] = useState({});
  const [compareState, setCompareState] = useState({ mode: 'env' });
  const [filter, setFilter] = useState({ category: 'all', min: 'all' });
  const [view, setView] = useState('pages');
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
  const env = useEnvironment('lantern', cwd);
  const envRef = useRef(env);
  envRef.current = env;
  const [, setMoodTick] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setMoodTick((n) => n + 1), 8100);
    return () => clearTimeout(t);
  }, [entries]);
  const [flash, setFlash] = useState(null);
  const nothingToCopy = () => setFlash({ text: 'Drag over text to copy it · q quits' });
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 3000);
    return () => clearTimeout(t);
  }, [flash]);

  const [reaction, setReaction] = useState(null);
  const reactionRef = useRef(null);
  reactionRef.current = reaction;
  const seenMoods = useRef(new Set());
  useEffect(() => {
    if (config.familyMoods === false || !moodEvery) return setReaction(null);
    const look = () => {
      const r = reactionTo(readMoods('lantern'), seenMoods.current);
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
  const pagesRef = useRef([]);
  const extraRef = useRef([]);
  const hostsRef = useRef([]);
  const selectedRef = useRef(0);
  const historyRef = useRef(history);
  const domainsRef = useRef({});
  const busyRef = useRef(null);
  const configRef = useRef(config);
  const promptRef = useRef(prompt);
  const confirmRef = useRef(null);
  const focusRef = useRef('view');
  const overlayRef = useRef(null);
  const nextId = useRef(1);
  const historyPos = useRef(-1);
  const lastOutput = useRef(null);
  const keySeq = useRef(0);
  const prefillKey = useRef(-1);
  const answerKey = useRef(-1);
  const { internal_eventEmitter: inputEvents } = useStdin();
  useEffect(() => {
    if (!inputEvents) return;
    const count = () => keySeq.current++;
    inputEvents.prependListener('input', count);
    return () => inputEvents.removeListener('input', count);
  }, [inputEvents]);

  const setPages = (folder, domains) => {
    const list = [...folder, ...extraRef.current.filter((x) => !folder.some((p) => p.url === x.url))];
    pagesRef.current = list;
    setPagesState(list);
    hostsRef.current = [...new Set([...domains, ...extraRef.current.map((p) => new URL(p.url).hostname)])];
    setHostsState(hostsRef.current);
    if (selectedRef.current >= list.length) select(0);
  };
  const select = (i) => {
    selectedRef.current = i;
    setSelectedState(i);
  };
  const setHistory = (next) => {
    historyRef.current = next;
    setHistoryState(next);
    saveHistory(next);
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
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const familyLog = (text, kind = 'info') => {
    if (configRef.current.familyMoods !== false) logActivity('lantern', { text, kind, project: cwdRef.current });
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
    setWelcome(false);
    try {
      const result = await start(controller.signal);
      const { stdout = '', stderr = '' } = result;
      const out = [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join('\n');
      lastOutput.current = { title, text: out || '(no output)' };
      updateEntry(id, { status: 'ok', lines: out ? out.split('\n') : ['Done'] });
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
    prefillKey.current = keySeq.current;
  };

  const resultFor = (url) => historyRef.current[url]?.at(-1) ?? null;
  // A result's findings as shown: without what the settings ignore, the counts made again.
  const shown = (r) => (r ? withoutIgnored(r.findings, configRef.current.ignore ?? []) : []);

  const ctxRef = useRef(null);
  if (!ctxRef.current)
    ctxRef.current = {
      get config() {
        return configRef.current;
      },
      get pages() {
        return pagesRef.current;
      },
      get hosts() {
        return hostsRef.current;
      },
      get env() {
        return envRef.current;
      },
      mouseHandlers: [],
    };
  const ctx = ctxRef.current;
  Object.assign(ctx, {
    provider,
    cwd: () => cwdRef.current,
    moveTo: (dir) => {
      cwdRef.current = dir;
      setCwdState(dir);
      extraRef.current = [];
      select(0);
      setConfig((c) => ({ ...c, recent: remember(c.recent ?? [], dir) }));
    },
    setPages,
    select,
    selectedPage: () => pagesRef.current[selectedRef.current] ?? null,
    // /open: a page of this session's, selected.
    addPage: (page) => {
      const at = pagesRef.current.findIndex((p) => p.url === page.url);
      if (at >= 0) {
        select(at);
        return pagesRef.current[at];
      }
      extraRef.current = [...extraRef.current, page];
      const list = [...pagesRef.current, page];
      pagesRef.current = list;
      setPagesState(list);
      hostsRef.current = [...new Set([...hostsRef.current, new URL(page.url).hostname])];
      setHostsState(hostsRef.current);
      select(list.length - 1);
      return page;
    },
    addResult: (r) => setHistory(addRun(historyRef.current, r)),
    resultFor,
    runsOf: (url) => historyRef.current[url] ?? [],
    latestResults: () => pagesRef.current.map((p) => resultFor(p.url)).filter(Boolean),
    shownFindings: shown,
    setDomain: (d) => {
      domainsRef.current = { ...domainsRef.current, [d.host]: d };
      setDomainsState(domainsRef.current);
    },
    setCompare: (c) => setCompareState(c),
    task,
    note,
    confirm,
    prefill,
    progress: (text) => alive.current && setProgress(text),
    logActivity: familyLog,
    // ctrl+r: the selected page audited again.
    refresh: () => (ctx.selectedPage() ? a.audit(ctx, ctx.selectedPage()) : a.loadPages(ctx)),
    setConfig,
    setView,
    setFilter,
    openUrl: (url) => (openUrl ? openUrl(url) : note(`Open ${url}`)),
    updateNow: () => {
      if (askHostToUpdate()) return note('Asked Fleet to look for a new version of the whole fleet.');
      if (!checkUpdate) return note(`This Lantern (${VERSION}) runs from a checkout: git pull updates it.`);
      if (update?.state === 'installing') return note(`Lantern ${update.latest} is being installed already.`);
      if (update?.state === 'installed') return note(`Lantern ${update.latest} is installed. It starts the next time you open Lantern.`);
      const said = (text) => ({ stdout: text, stderr: '' });
      return task(
        'Looking for a new version of Lantern',
        async () => {
          const { checked, newer } = await checkUpdate(null);
          setConfig((c) => ({ ...c, lastUpdateCheck: checked }));
          if (!newer) return said(`Lantern ${VERSION} is the latest version.`);
          if (!installUpdate) {
            setUpdate({ ...checked, state: 'out' });
            return said(`Lantern ${checked.latest} is out (you have ${VERSION}). Download it from ${checked.url}`);
          }
          setUpdate({ ...checked, state: 'installing' });
          try {
            await installUpdate(checked.latest);
          } catch (e) {
            setUpdate({ ...checked, state: 'out' });
            throw new Error(`Lantern ${checked.latest} is out, but it couldn't be installed: ${firstLine(e.message)}\nDownload it from ${checked.url}`);
          }
          setUpdate({ ...checked, state: 'installed' });
          return said(`Lantern ${checked.latest} is installed. It starts the next time you open Lantern.`);
        },
        { label: 'Updating Lantern' },
      );
    },
    copy: (text, what = text) => {
      if (!copy) return note("Copying to the clipboard isn't available here.", 'error');
      copy(text);
      setFlash({ text: `Copied ${what}` });
    },
    viewHasKeys: () => focusRef.current === 'view' && !overlayRef.current && !confirmRef.current && answerKey.current !== keySeq.current,
    overlayHasKeys: () => focusRef.current === 'view' && !confirmRef.current && answerKey.current !== keySeq.current,
    quit: () => exit(),
    showText: (title, text) => setOverlay({ title, text }),
    closeOverlay: () => setOverlay(null),
    showHelp: () => setOverlay({ kind: 'help', start: sectionFor(HELP_SECTIONS, view) }),
    showLast: () => (lastOutput.current ? setOverlay({ ...lastOutput.current }) : note('No command has run yet.')),
  });

  const runLine = async (text) => {
    try {
      if (text.startsWith('!')) return (await a.raw(ctx, text.slice(1).trim())) !== false;
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
    const hist = [text, ...(configRef.current.history ?? []).filter((h) => h !== text)].slice(0, 100);
    setConfig((c) => ({ ...c, history: hist }));
    await runLine(text);
    recordCommand('lantern', decodeContext(text) ? `/take ${text}` : text);
  };

  // The folder's pages on opening (the chosen environment's first), then a look for a newer release.
  useEffect(() => {
    a.loadPages(ctx);
    const envName = envRef.current?.name;
    const first = pagesRef.current.findIndex((p) => p.env === envName);
    if (first > 0) select(first);
    if (checkUpdate && configRef.current.checkForUpdates !== false) {
      checkUpdate(configRef.current.lastUpdateCheck).then(
        ({ checked, newer }) => {
          setConfig((c) => ({ ...c, lastUpdateCheck: checked }));
          if (!newer) return;
          const outNote = (why = '') => note(`Lantern ${checked.latest} is out (you have ${VERSION})${why}.\nDownload it from ${checked.url}`);
          if (!installUpdate || configRef.current.autoUpdate === false) {
            setUpdate({ ...checked, state: 'out' });
            return outNote();
          }
          setUpdate({ ...checked, state: 'installing' });
          installUpdate(checked.latest).then(
            () => {
              setUpdate({ ...checked, state: 'installed' });
              note(`Lantern ${checked.latest} is installed. It starts the next time you open Lantern.`);
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
  }, []);

  const title = `${basename(cwd) || cwd} · ${VIEWS.find((v) => v.id === view).label} — Lantern`;
  useEffect(() => {
    setTitle?.(title);
  }, [title]);

  const page = pages[selected] ?? null;
  const rawResult = page ? history[page.url]?.at(-1) ?? null : null;
  const pageFindings = rawResult ? withoutIgnored(rawResult.findings, config.ignore ?? []) : [];
  const result = rawResult ? { ...rawResult, findings: pageFindings, counts: countFindings(pageFindings) } : null;
  // Whether a browser is there, looked for once per setting rather than on every frame ('' found, null not).
  const chromeMemo = useRef({});
  if (chromeMemo.current.key !== (config.chrome ?? '')) chromeMemo.current = { key: config.chrome ?? '', found: provider.browser({ override: config.chrome }) ? '' : null };
  const chromeFound = chromeMemo.current.found;
  const suggestions = focus === 'prompt' && !confirmReq ? suggestionsFor(prompt.value, { pages, hosts, config, cwd }) : [];
  const sel = Math.min(sugIndex, Math.max(0, suggestions.length - 1));
  const domainFindings = Object.values(domainResults).reduce((n, d) => n + d.findings.length, 0);

  const sendKey = useKeyTranslation((input) => {
    if (focusRef.current === 'view' && !confirmRef.current && overlayRef.current?.kind !== 'help') return shortcutKey(input);
    return input;
  });
  void sendKey;

  const promptKeys = (input, key) => {
    const { value, cursor } = promptRef.current;
    const items = suggestionsFor(value, { pages: pagesRef.current, hosts: hostsRef.current, config: configRef.current, cwd: cwdRef.current });
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
      const hist = configRef.current.history ?? [];
      const pos = Math.max(-1, Math.min(hist.length - 1, historyPos.current + (key.upArrow ? 1 : -1)));
      historyPos.current = pos;
      return setPrompt(pos < 0 ? '' : hist[pos]);
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

  useInput((input, key) => {
    if (focusRef.current === 'prompt' && !confirmRef.current) return prefillKey.current === keySeq.current ? undefined : promptKeys(input, key);
    if (key.ctrl && input === 'c') return nothingToCopy();
    if (confirmRef.current || overlayRef.current || answerKey.current === keySeq.current) return;
    globalKeys(input, key);
  });

  useEffect(() => {
    mouse?.enable(config.mouse !== false);
  }, [config.mouse]);

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
      if (overlayRef.current) ctx.closeOverlay();
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
    const row = e.y - (layout.current.box?.items ?? promptTop + 1);
    if (row >= 0 && row < sugCount) {
      setSugIndex(row);
      if (e.double) promptKeys('', { return: true });
    }
  };
  const mouseRef = useRef(onMouse);
  mouseRef.current = onMouse;
  useEffect(() => mouse?.subscribe((e) => mouseRef.current(e)), [mouse]);
  useEffect(() => mouse?.claimDrags?.(() => false), [mouse]);

  const W = columns;
  const H = Math.max(12, rows);
  const act = activityRows(entries.filter((e) => e.shown !== false));
  const bottom = confirmReq ? confirmHeight(confirmReq) : commandRows(suggestions.length);
  const mood = moodFor({ result, busy, lastEntry: entries.at(-1) });
  const feeling = familyMood({ mood, result, lastEntry: entries.at(-1), busy });
  useEffect(() => {
    if (config.familyMoods !== false) writeMood('lantern', feeling);
  }, [feeling.mood, feeling.reason, config.familyMoods]);
  const viewActive = focus === 'view' && !overlay && !confirmReq;
  const tabCounts = { findings: pageFindings.length, domains: domainFindings, pages: pages.length };
  // The top line, then the view, the activity, the prompt and its suggestions, then the status line.
  const top = topLine({ face: FACES[mood], title: 'Lantern', views: viewTabs(entries, tabCounts), view, context: headerContext({ page, result, cwd, env, chrome: chromeFound }), width: W, compact: true });
  const mainH = Math.max(6, H - 1 - act.length - (busy ? 1 : 0) - bottom - 1);
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

  const common = { ctx, width: W, height: mainH, active: viewActive };
  let main;
  if (overlay?.kind === 'help') {
    main = <HelpView sections={HELP_SECTIONS} start={overlay.start} ctx={ctx} width={W} height={mainH} active={focus === 'view' && !confirmReq} onClose={() => queueMicrotask(ctx.closeOverlay)} />;
  } else if (overlay) {
    main = <Viewer key={viewerKey(overlay)} title={overlay.title} text={overlay.text} ctx={ctx} width={W} height={mainH} active={focus === 'view' && !confirmReq} onClose={() => queueMicrotask(ctx.closeOverlay)} />;
  } else if (view === 'log') {
    main = <LogView entries={entries} {...common} />;
  } else if (view === 'findings') {
    main = <FindingsView page={page} result={result} filter={filter} {...common} />;
  } else if (view === 'compare') {
    main = <CompareView page={page} pages={pages} history={history} mode={compareState} ignore={config.ignore ?? []} {...common} />;
  } else if (view === 'waterfall') {
    main = <WaterfallView page={page} result={result} {...common} />;
  } else if (view === 'domains') {
    main = <DomainsView hosts={hosts} domains={domainResults} {...common} />;
  } else {
    main = <PagesView pages={pages} selected={selected} history={history} ignore={config.ignore ?? []} env={env} {...common} />;
  }

  const keys = focus === 'prompt' ? 'enter run · tab complete · ↑↓ pick or history · esc back' : overlay?.kind === 'help' ? 'j/k section · space scroll · / search · esc close' : overlay ? 'j/k scroll · space page · / search · y copy · esc close' : HINTS[view];
  const right = focus === 'prompt' ? '' : '/ commands · ! shell · , settings · ? help';
  // What the status line says beside the face: a flash, a sibling's news, the welcome until the first
  // command, else how Flit sees things.
  const told = { pages, result, chrome: chromeFound };
  let said = { face: FACES[mood], message: moodLine(mood, told), tone: chromeFound === null ? 'warn' : undefined };
  if (flash) said = { face: FACES[mood], message: flash.text, news: true };
  else if (reaction) said = { face: FACES[reaction.mood === 'happy' ? 'happy' : 'worried'], message: [{ text: reaction.text }, { text: '  esc', color: theme.dim }], news: true };
  else if (welcome && update) said = { face: FACES[mood], message: updateLine(update), tone: 'warn' };
  else if (welcome) said = { face: FACES[mood], message: welcomeLine('Lantern', VERSION, `${PET.name} the ${PET.kind} here. ${moodLine(mood, told)}`) };

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
