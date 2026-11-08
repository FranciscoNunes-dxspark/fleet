import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdin } from 'ink';
import * as a from '../actions.js';
import { COMMANDS, findCommand, suggestionsFor } from '../commands.js';
import { saveConfig } from '../config.js';
import { HELP } from '../help.js';
import { commandsSection, sectionFor } from '@fleet/kit/help-layout.js';
import { askHostToUpdate } from '@fleet/kit/hosted.js';
import { createDocker, dockerProblem } from '../docker.js';
import { createKube } from '../kube.js';
import { explainKube } from '../kubeactions.js';
import { BULLET, theme } from '../theme.js';
import { VERSION } from '../app.js';
import { useEnvironment, useKeyTranslation, useTerminalSize } from '@fleet/kit/ui/hooks.js';
import { recordCommand } from '@fleet/kit/recording.js';
import { readProject } from '@fleet/kit/environments.js';
import { shortcutKey } from '@fleet/kit/keymap.js';
import { Confirm, Panel, PromptBox, Row, SecretPrompt, Spinner, Suggestions, confirmHeight, promptHeight } from '@fleet/kit/ui/parts.jsx';
import { StatusLine, topLine, welcomeLine } from '@fleet/kit/ui/shell.jsx';
import { HelpView } from '@fleet/kit/ui/HelpView.jsx';
import { ContainersView } from './ContainersView.jsx';
import { ImagesView } from './ImagesView.jsx';
import { PodsView } from './PodsView.jsx';
import { LogView } from './LogView.jsx';
import { Viewer } from './Viewer.jsx';
import { ShellPane } from './ShellPane.jsx';
import { RolloutView } from './RolloutView.jsx';
import { SecurityView } from './SecurityView.jsx';
import { securityCheck } from '../headless.js';
import { worstByContainer } from '../security.js';
import { commandLine } from '../shell.js';
import { spawn } from 'node:child_process';
import { PET_WIDTH, Pet, updateLine } from './Pet.jsx';
import { FACES, PET, moodFor, moodLine } from '../pet.js';
import { decodeContext, logActivity, pastedLine, readMoods, writeMood } from '@fleet/kit/family.js';
import { familyMood, reactionTo } from '../moods.js';

const VIEWS = [
  { id: 'containers', label: 'Containers' },
  { id: 'images', label: 'Images' },
  { id: 'pods', label: 'Pods' },
  { id: 'log', label: 'Log' },
];

const HINTS = {
  containers: '↵ log · e shell · s stop/start · r restart · x remove · i inspect · o open · a only running · p pause · v scan · alt+s security',
  images: 'x remove · p prune unused · v scan · y copy id',
  pods: '↵ log · c a container\'s log · e shell · x delete · r restart deployment · w watch rollout · i describe · y copy name',
  log: '↵ all its output · y copy it',
};

const HELP_SECTIONS = [...HELP, commandsSection(COMMANDS)];
const DOUBLE_CLICK_MS = 400;
const firstLine = (s) => String(s ?? '').split('\n')[0];

// What the top line says at its right: the provider when it isn't Docker, the environment, how many
// containers run and how many aren't well, or what went wrong.
function headerContext({ data, loading, problem, provider, env }) {
  const segs = [];
  if (provider !== 'docker') segs.push({ text: provider, color: theme.warn }, { text: '  ' });
  if (env) segs.push({ text: env.name, color: env.prod ? theme.del : theme.info, bold: env.prod }, { text: '  ' });
  if (problem) segs.push({ text: firstLine(problem), color: theme.warn }, { text: '  ' });
  if (data) {
    const up = data.containers.filter((c) => c.state === 'running').length;
    const bad = data.containers.filter((c) => c.health === 'unhealthy' || (c.state === 'exited' && c.exitCode > 0)).length;
    if (bad) segs.push({ text: `${bad} not well`, color: theme.del, bold: true }, { text: '  ' });
    segs.push({ text: `${up}/${data.containers.length} running`, color: theme.dim });
  } else if (loading) segs.push({ text: 'loading…', color: theme.dim });
  return segs;
}

// The views in the top line, the digit that picks each before it and the log's count after it.
const viewTabs = (entries) =>
  VIEWS.map((v, i) => ({ id: v.id, key: i + 1, label: v.label, count: v.id === 'log' && entries.length ? entries.length : 0, countColor: theme.dim }));

// The last two results, Claude Code style: "● docker stop web" then "  ⎿  output".
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

// `provider` is docker.js's and `kube` kube.js's (demo.js's and demokube.js's for --demo and the tests); `pollEvery` is how often Docker is read
// again in ms (0: never, for the tests). `copy` puts text on the clipboard (cli.jsx's; tests pass a stub),
// `openUrl` opens the browser, `notify` is called when a long command ends. `checkUpdate` and `installUpdate`
// come only in the downloaded builds, so tests and checkouts never go online or replace anything.
// `runInTerminal(command, args)` hands the terminal to a program and takes it back (cli.jsx's, only
// outside Fleet); without it a shell (e) runs in the line-mode pane, started by `spawnShell`.
// `rolloutEvery` is how often a rollout being followed is read again, in ms. `cwd` is the folder whose
// project's environments (.fleet/project.json) Wharf follows.
export function App({ config: initialConfig, cwd = process.cwd(), provider = createDocker(), kube = createKube(), pollEvery = 3000, rolloutEvery = 2000, moodEvery = 30_000, openUrl, setTitle, mouse, copy, checkUpdate, installUpdate, runInTerminal, spawnShell = spawn }) {
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize();
  const [config, setConfigState] = useState(initialConfig);
  const [data, setDataState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState(null);
  const [view, setView] = useState('containers');
  const [focus, setFocusState] = useState('view');
  const [prompt, setPromptState] = useState({ value: '', cursor: 0 });
  const [sugIndex, setSugIndex] = useState(0);
  const [overlay, setOverlayState] = useState(null);
  const [confirmReq, setConfirmReq] = useState(null);
  const [entries, setEntries] = useState([]);
  const [busy, setBusy] = useState(null);
  const [welcome, setWelcome] = useState(true);
  const [update, setUpdate] = useState(null);
  const [onlyRunning, setOnlyRunning] = useState(false);
  // Each container's worst security finding (security.js), for the list's marker: a Map from its name.
  const [security, setSecurityState] = useState(null);
  const securityKey = useRef(null);
  const setSecurity = (findings) => setSecurityState(worstByContainer(findings));
  // The cluster, read only while the Pods view is on screen (kubectl may not even be installed): { pods, top, namespace, context, problem }.
  const [kubeData, setKubeDataState] = useState(null);
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

  // A sibling's mood Bark reacts to (family.js's readMoods, every `moodEvery` ms): one line until esc.
  const [reaction, setReaction] = useState(null);
  const reactionRef = useRef(null);
  reactionRef.current = reaction;
  const seenMoods = useRef(new Set());
  useEffect(() => {
    if (config.familyMoods === false || !moodEvery) return setReaction(null);
    const look = () => {
      const r = reactionTo(readMoods('wharf'), seenMoods.current);
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

  const viewRef = useRef(view);
  viewRef.current = view;
  const kubeRef = useRef(null);
  const kubeNamespace = useRef(initialConfig.kubeNamespace ?? 'all');
  // The project's environment, as Wharf's section has it: { name, prod, context?, namespace? } or null.
  const env = useEnvironment('wharf', cwd);
  const envRef = useRef(env);
  envRef.current = env;
  const setKubeData = (next) => {
    kubeRef.current = next;
    setKubeDataState(next);
  };
  const setData = (next) => {
    dataRef.current = next;
    setDataState(next);
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

  // Docker, read again: the list and the images together, then each running container's CPU and memory
  // (slower, so it never holds the list up). One read at a time; a failure keeps what was there and says why.
  const reading = useRef(false);
  const readingStats = useRef(false);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const reload = async () => {
    if (reading.current) return;
    reading.current = true;
    try {
      const [containers, images] = await Promise.all([provider.containers(), provider.images()]);
      if (!alive.current) return;
      setData({ containers, images, stats: dataRef.current?.stats ?? new Map() });
      setProblem(null);
      // The security check's markers, quietly, whenever the containers are others than last time (one docker inspect).
      const key = containers.map((c) => c.id).join(',');
      if (provider.inspectAll && key !== securityKey.current) {
        securityKey.current = key;
        securityCheck(provider, { ids: containers.map((c) => c.id), ignore: configRef.current.securityIgnore ?? [] }).then(
          (r) => alive.current && setSecurity(r.findings),
          () => {},
        );
      }
      // One stats read at a time: `docker stats --no-stream` over many containers can take longer than
      // the poll, and each read left running would be another one sampling every container.
      if (!readingStats.current) {
        readingStats.current = true;
        provider
          .stats()
          .then(
            (stats) => alive.current && dataRef.current && setData({ ...dataRef.current, stats }),
            () => {},
          )
          .finally(() => {
            readingStats.current = false;
          });
      }
    } catch (e) {
      if (alive.current) setProblem(dockerProblem(e.message) ?? firstLine(e.message));
    } finally {
      reading.current = false;
      if (alive.current) setLoading(false);
    }
  };

  // The cluster, read again: the pods and the context, then CPU and memory when there's a metrics server. A failure keeps the pods that were there and says why.
  const readingKube = useRef(false);
  const reloadKube = async () => {
    if (readingKube.current) return;
    readingKube.current = true;
    const namespace = kubeNamespace.current;
    try {
      const [pods, context] = await Promise.all([kube.pods({ namespace }), kube.current().catch(() => null)]);
      if (!alive.current) return;
      setKubeData({ pods, top: kubeRef.current?.top ?? new Map(), namespace, context, problem: null });
      kube.top({ namespace }).then(
        (top) => alive.current && kubeRef.current && setKubeData({ ...kubeRef.current, top }),
        () => {},
      );
    } catch (e) {
      if (alive.current) setKubeData({ pods: kubeRef.current?.pods ?? [], top: kubeRef.current?.top ?? new Map(), namespace, context: kubeRef.current?.context ?? null, problem: explainKube(e).message });
    } finally {
      readingKube.current = false;
    }
  };

  const task = async (title, start, { label = 'Working', refresh = false, refreshKube = false, activity, project } = {}) => {
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
    try {
      const result = await start(controller.signal);
      const { stdout = '', stderr = '' } = result;
      const out = [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join('\n');
      lastOutput.current = { title, text: out || '(no output)' };
      updateEntry(id, { status: 'ok', lines: out ? out.split('\n') : ['Done'] });
      // What changed something goes in the family's activity log (/timeline in the others), with the project's folder when it has one.
      if (activity && configRef.current.familyMoods !== false) logActivity('wharf', { text: activity, kind: 'change', project });
      return { ok: true, out, result };
    } catch (error) {
      lastOutput.current = { title, text: error.message };
      updateEntry(id, { status: 'error', lines: error.cancelled ? ['Cancelled'] : error.message.split('\n') });
      return { ok: false, error };
    } finally {
      busyRef.current = null;
      setBusy(null);
      if (refresh) await reload();
      if (refreshKube) await reloadKube();
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
  if (!ctxRef.current) ctxRef.current = { get data() { return dataRef.current; }, get config() { return configRef.current; }, mouseHandlers: [] };
  const ctx = ctxRef.current;
  Object.assign(ctx, {
    provider,
    kube,
    get kubeData() {
      return kubeRef.current;
    },
    get env() {
      return envRef.current;
    },
    cwd,
    // The namespace the Pods view lists, read or not yet: what a deployment named alone is looked for in.
    get kubeNamespace() {
      return kubeNamespace.current;
    },
    task,
    note,
    confirm,
    // A masked field in the confirm's place: resolves { value } (or null on esc).
    askText: async (req) => (await confirm({ ...req, secret: true, plain: true, options: [] }))?.value ?? null,
    prefill,
    // /refresh: Docker, and the cluster too when it's the one on screen.
    refresh: () => (viewRef.current === 'pods' ? reloadKube() : reload()),
    setKubeNamespace: (namespace) => {
      kubeNamespace.current = namespace;
      // An environment's namespace is its own; only one chosen without it is remembered.
      if (!envRef.current?.namespace) setConfig((c) => ({ ...c, kubeNamespace: namespace }));
      reloadKube();
    },
    // Settings change through App's copy, the only one written to disk (ctx.config reads it).
    setConfig,
    setView,
    setOnlyRunning,
    openUrl: (url) => (openUrl ? openUrl(url) : note(`Open ${url}`)),
    // /update: asks for the latest release now, whatever the daily check last said, and installs it.
    updateNow: () => {
      if (askHostToUpdate()) return note('Asked Fleet to look for a new version of the whole fleet.');
      if (!checkUpdate) return note(`This Wharf (${VERSION}) runs from a checkout: git pull updates it.`);
      if (update?.state === 'installing') return note(`Wharf ${update.latest} is being installed already.`);
      if (update?.state === 'installed') return note(`Wharf ${update.latest} is installed. It starts the next time you open Wharf.`);
      const said = (text) => ({ stdout: text, stderr: '' });
      return task(
        'Looking for a new version of Wharf',
        async () => {
          const { checked, newer } = await checkUpdate(null);
          setConfig((c) => ({ ...c, lastUpdateCheck: checked }));
          if (!newer) return said(`Wharf ${VERSION} is the latest version.`);
          if (!installUpdate) {
            setUpdate({ ...checked, state: 'out' });
            return said(`Wharf ${checked.latest} is out (you have ${VERSION}). Download it from ${checked.url}`);
          }
          setUpdate({ ...checked, state: 'installing' });
          try {
            await installUpdate(checked.latest);
          } catch (e) {
            setUpdate({ ...checked, state: 'out' });
            throw new Error(`Wharf ${checked.latest} is out, but it couldn't be installed: ${firstLine(e.message)}\nDownload it from ${checked.url}`);
          }
          setUpdate({ ...checked, state: 'installed' });
          return said(`Wharf ${checked.latest} is installed. It starts the next time you open Wharf.`);
        },
        { label: 'Updating Wharf' },
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
    // /security's findings over the view ({ title, findings, arg }), and every container's for the markers.
    showSecurity: (what) => setOverlay({ kind: 'security', ...what }),
    setSecurity,
    // A container's log, followed: read again every moment while it's open.
    showLogs: (c, opts = {}) => setOverlay({ kind: 'logs', title: `${c.name} · log`, process: c.name, project: c.workingDir ?? undefined, source: () => provider.logs(c.id, { tail: 500 }), ...opts }),
    // One container's (`container`), or every one of the pod's.
    showPodLogs: (p, { container, ...opts } = {}) => setOverlay({ kind: 'logs', title: `${p.name}${container ? `/${container}` : ''} · log`, process: p.name, source: () => kube.logs(p, { tail: 500, container }), ...opts }),
    shareTrouble: (what) => a.shareTrouble(ctx, what),
    // A deployment's rollout ({ deployment, namespace }), followed over the view.
    showRollout: (target) => setOverlay({ kind: 'rollout', title: `rollout ${target.namespace}/${target.deployment}`, target }),
    // e: a shell, `make(tty)` saying the command ({ command, args }). With a terminal to hand over it
    // runs there until it ends; inside Fleet (no terminal) in the line-mode pane.
    openShell: ({ title, make }) => {
      if (!runInTerminal) return setOverlay({ kind: 'shell', title, shell: make(false) });
      const sh = make(true);
      const r = runInTerminal(sh.command, sh.args, { mouse: configRef.current.mouse !== false });
      if (r?.error) return note(/ENOENT/.test(r.error.message) ? `${sh.command} isn't installed (or isn't on the PATH).` : `Couldn't start ${commandLine(sh)}: ${firstLine(r.error.message)}`, 'error');
      // 130 is the shell's own ctrl+c on the way out; anything else but 0 is worth a word.
      note(r?.status && r.status !== 130 ? `${title}'s shell ended with ${r.status}.` : `Back from ${title}'s shell.`, r?.status && r.status !== 130 ? 'error' : 'info');
    },
    closeOverlay: () => setOverlay(null),
    showHelp: () => setOverlay({ kind: 'help', start: sectionFor(HELP_SECTIONS, view) }),
    showLast: () => (lastOutput.current ? setOverlay({ ...lastOutput.current }) : note('No command has run yet.')),
  });

  // One line as typed at the prompt: a shell command after !, else a slash command. Resolves false when it failed.
  const runLine = async (text) => {
    try {
      if (text.startsWith('!')) return (await a.raw(ctx, text.slice(1).trim())) !== false;
      // A sibling's context pasted alone is /take's.
      if (decodeContext(text)) {
        const ok = (await a.take(ctx, text)) !== false;
        recordCommand('wharf', `/take ${text}`);
        return ok;
      }
      const [, name, rest] = text.replace(/^\//, '').match(/^(\S+)\s*([\s\S]*)$/);
      const cmd = findCommand(name);
      if (!cmd) {
        note(`Unknown command: /${name}. Type / to see them all.`, 'error');
        return false;
      }
      const r = await cmd.run(ctx, rest.trim());
      // For a runbook Fleet is recording: the line as typed, once it has run.
      recordCommand('wharf', text);
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

  // Read Docker on opening and every `pollEvery` ms, then look for a newer release (after the first read, so it doesn't slow it).
  useEffect(() => {
    (async () => {
      await reload();
      if (checkUpdate && configRef.current.checkForUpdates !== false) {
        checkUpdate(configRef.current.lastUpdateCheck).then(
          ({ checked, newer }) => {
            setConfig((c) => ({ ...c, lastUpdateCheck: checked }));
            if (!newer) return;
            const outNote = (why = '') => note(`Wharf ${checked.latest} is out (you have ${VERSION})${why}.\nDownload it from ${checked.url}`);
            if (!installUpdate || configRef.current.autoUpdate === false) {
              setUpdate({ ...checked, state: 'out' });
              return outNote();
            }
            // In the background, without the spinner: nothing waits on it, and it only counts from the next start.
            setUpdate({ ...checked, state: 'installing' });
            installUpdate(checked.latest).then(
              () => {
                setUpdate({ ...checked, state: 'installed' });
                note(`Wharf ${checked.latest} is installed. It starts the next time you open Wharf.`);
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
    if (!pollEvery) return;
    const t = setInterval(() => {
      // Not while something is being asked or a command runs: the list changes under it enough already.
      if (!busyRef.current) reload();
    }, pollEvery);
    return () => clearInterval(t);
  }, []);

  // The environment's context and namespace (Wharf's section of .fleet/project.json): kubectl goes there
  // with --context and the Pods view lists that namespace, while kubectl's own context stays as it is.
  // Switched elsewhere (another app, Fleet) it applies here too, and the cluster is read again.
  const envKey = `${env?.name ?? ''}\0${env?.context ?? ''}\0${env?.namespace ?? ''}`;
  const firstEnv = useRef(true);
  useEffect(() => {
    try {
      kube.pin?.(env?.context ?? null);
    } catch (e) {
      note(`The ${env.name} environment's context: ${firstLine(e.message)}`, 'error');
    }
    kubeNamespace.current = env?.namespace ?? configRef.current.kubeNamespace ?? 'all';
    if (firstEnv.current) {
      firstEnv.current = false;
      return;
    }
    setKubeData(null);
    if (viewRef.current === 'pods') reloadKube();
  }, [envKey]);

  // The cluster is read when the Pods view opens and, while it stays on screen, every `pollEvery` ms.
  useEffect(() => {
    if (view !== 'pods') return;
    reloadKube();
    if (!pollEvery) return;
    const t = setInterval(() => {
      if (!busyRef.current) reloadKube();
    }, pollEvery);
    return () => clearInterval(t);
  }, [view]);

  // cli.jsx passes the terminal's title setter; tests pass a stub or nothing.
  const title = `${VIEWS.find((v) => v.id === view).label} — Wharf`;
  useEffect(() => {
    setTitle?.(title);
  }, [title]);

  // The project's environments, read only while /env is being typed.
  const envNames = (value) => (/^\/env\s/.test(value) ? (readProject(cwd)?.names ?? []) : undefined);
  const suggestions = focus === 'prompt' && !confirmReq ? suggestionsFor(prompt.value, { data, kube: kubeData, envs: envNames(prompt.value) }) : [];
  const sel = Math.min(sugIndex, Math.max(0, suggestions.length - 1));

  // Uppercase shortcuts are alt+letter (caps lock can't fire them); typing in a prompt or a confirm is left alone.
  const sendKey = useKeyTranslation((input) => {
    // The help's search and the shell pane take letters as they are typed.
    if (focusRef.current === 'view' && !confirmRef.current && !['help', 'shell'].includes(overlayRef.current?.kind)) return shortcutKey(input);
    return input;
  });
  void sendKey;

  // Line editing in the prompt.
  const promptKeys = (input, key) => {
    const { value, cursor } = promptRef.current;
    const items = suggestionsFor(value, { data: dataRef.current, kube: kubeRef.current, envs: envNames(value) });
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
    if (key.ctrl && input === 'r') return reload();
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
    // In the shell pane ctrl+c is the shell's.
    if (key.ctrl && input === 'c' && overlayRef.current?.kind !== 'shell') return nothingToCopy();
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
    if (e.y === promptTop) {
      // The text starts after a space and "> ", scrolled as PromptBox scrolls it.
      const { value, cursor } = promptRef.current;
      const inner = columns - 3;
      const start = focusRef.current === 'prompt' ? Math.max(0, cursor - inner + 1) : 0;
      setPrompt(value, Math.max(0, Math.min(value.length, start + e.x - 3)));
      return setFocus('prompt');
    }
    const row = e.y - promptTop - 1;
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
  const bottom = confirmReq ? confirmHeight(confirmReq) : promptHeight() + suggestions.length;
  const mood = moodFor({ data, busy, lastEntry: entries.at(-1) });
  // How Bark feels, for the siblings (family.js's writeMood), whenever that changes.
  const told = familyMood({ mood, data, kubeData, lastEntry: entries.at(-1), busy });
  useEffect(() => {
    if (config.familyMoods !== false) writeMood('wharf', told);
  }, [told.mood, told.reason, config.familyMoods]);
  // The top line, then the view, the activity, the prompt and its suggestions, then the status line.
  const top = topLine({ face: FACES[mood], title: 'Wharf', views: viewTabs(entries), view, context: headerContext({ data, loading, problem: data ? problem : null, provider: provider.name, env }), width: W });
  const mainH = Math.max(6, H - 1 - act.length - (busy ? 1 : 0) - bottom - 1);
  const viewActive = focus === 'view' && !overlay && !confirmReq;
  layout.current = {
    mainTop: 1,
    mainH,
    promptTop: 1 + mainH + act.length + (busy ? 1 : 0),
    sugCount: suggestions.length,
    tabs: top.tabs.map((t) => ({ id: t.id, from: t.x, to: t.x + t.width })),
  };

  let main;
  if (overlay?.kind === 'help') {
    main = <HelpView sections={HELP_SECTIONS} start={overlay.start} ctx={ctx} width={W} height={mainH} active={focus === 'view' && !confirmReq} onClose={() => queueMicrotask(ctx.closeOverlay)} />;
  } else if (overlay?.kind === 'shell') {
    main = <ShellPane key={viewerKey(overlay)} title={overlay.title} shell={overlay.shell} spawnShell={spawnShell} ctx={ctx} width={W} height={mainH} active={focus === 'view' && !confirmReq} onClose={() => queueMicrotask(ctx.closeOverlay)} />;
  } else if (overlay?.kind === 'security') {
    main = <SecurityView key={viewerKey(overlay)} title={overlay.title} findings={overlay.findings} arg={overlay.arg} ctx={ctx} width={W} height={mainH} active={focus === 'view' && !confirmReq} onClose={() => queueMicrotask(ctx.closeOverlay)} />;
  } else if (overlay?.kind === 'rollout') {
    main = <RolloutView key={viewerKey(overlay)} target={overlay.target} every={rolloutEvery} ctx={ctx} width={W} height={mainH} active={focus === 'view' && !confirmReq} onClose={() => queueMicrotask(ctx.closeOverlay)} />;
  } else if (overlay) {
    main = <Viewer key={viewerKey(overlay)} title={overlay.title} text={overlay.text} source={overlay.source} log={overlay.kind === 'logs'} process={overlay.process} project={overlay.project} search={overlay.search} ctx={ctx} width={W} height={mainH} active={focus === 'view' && !confirmReq} onClose={() => queueMicrotask(ctx.closeOverlay)} />;
  } else if (view === 'log') {
    main = <LogView entries={entries} ctx={ctx} width={W} height={mainH} active={viewActive} />;
  } else if (view === 'pods') {
    main = <PodsView kube={kubeData} ctx={ctx} width={W} height={mainH} active={viewActive} />;
  } else if (!data) {
    main = (
      <Panel title={VIEWS.find((v) => v.id === view).label} width={W} height={mainH}>
        <Box marginTop={1} marginLeft={2}>
          <Box flexDirection="column" width={PET_WIDTH} marginRight={2}>
            <Pet mood={mood} />
          </Box>
          <Text color={theme.dim}>{loading ? 'Asking Docker…' : `${problem ?? 'Nothing read.'} /refresh tries again.`}</Text>
        </Box>
      </Panel>
    );
  } else if (view === 'images') {
    main = <ImagesView images={data.images} containers={data.containers} ctx={ctx} width={W} height={mainH} active={viewActive} />;
  } else {
    main = <ContainersView containers={data.containers} stats={data.stats} security={security} onlyRunning={onlyRunning} ctx={ctx} width={W} height={mainH} active={viewActive} />;
  }

  const keys = focus === 'prompt'
      ? 'enter run · tab complete · ↑↓ pick or history · esc back'
      : overlay?.kind === 'help'
        ? 'j/k section · space scroll · / search · esc close'
        : overlay?.kind === 'security'
          ? 'j/k move · ↵ the finding · y copy it · r check again · esc close'
        : overlay?.kind === 'rollout'
          ? 'u undo (asks) · l the log of a new pod · esc close'
        : overlay?.kind === 'shell'
          ? '↵ send · ↑↓ history · pgup pgdn scroll · ctrl+c twice stop · esc close'
        : overlay
          ? 'j/k scroll · space page · y copy · esc close'
          : HINTS[view];
  const right = focus === 'prompt' || overlay?.kind === 'shell' ? '' : '/ commands · ! shell · , settings · ? help';
  // What the status line says beside the face: a flash, a sibling's news, the welcome until the first
  // command, else how Bark sees things.
  let said = { face: FACES[mood], message: moodLine(mood, data) };
  if (flash) said = { face: FACES[mood], message: flash.text };
  else if (reaction) said = { face: FACES[reaction.mood === 'happy' ? 'happy' : 'worried'], message: [{ text: reaction.text }, { text: '  esc', color: theme.dim }] };
  // While the prompt has focus, its keys matter more than the welcome or Bark's mood.
  else if (focus === 'prompt') said = { face: FACES[mood], message: '' };
  else if (!data && problem) said = { face: FACES[mood], message: problem, tone: 'warn' };
  else if (welcome && update) said = { face: FACES[mood], message: updateLine(update), tone: 'warn' };
  else if (welcome) said = { face: FACES[mood], message: welcomeLine('Wharf', VERSION, `${PET.name} the ${PET.kind} here. ${moodLine(mood, data)}`) };

  return (
    <Box flexDirection="column" width={W} height={H}>
      <Row pointer={false} width={W} segments={top.segments} />
      <Box height={mainH} width={W}>
        {main}
      </Box>
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
      <StatusLine {...said} keys={keys} right={right} width={W} />
    </Box>
  );
}
