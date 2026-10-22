import React, { useEffect, useRef, useState } from 'react';
import { Box, useApp, useInput } from 'ink';
import * as a from '../actions.js';
import { COMMANDS, findCommand, suggestionsFor } from '../commands.js';
import { WI_VIEW_IDS, monitorFullText, pipelineDetail, prFullText, wiFullText } from '../format.js';
import { HELP } from '../help.js';
import { commandsSection, sectionFor } from '../help-layout.js';
import { logText } from '../log.js';
import path from 'node:path';
import { COMPILED, VERSION, openUrl as openInBrowser } from '../open.js';
import { openSonar as openSonarApp } from '../sonar.js';
import { saveEnvSettings } from '../setup.js';
import { ROOT } from '../../server/root.js';
import { FACES, moodFor } from '../pinch.js';
import { githubFullText, isGithubRelease, releaseFullText } from '../releases.js';
import { BULLET, theme } from '../theme.js';
import { fitSegments, stringWidth } from '../text.js';
import { mouseOn } from '../settings.js';
import { useTerminalSize } from './hooks.js';
import { Confirm, PromptBox, Row, Spinner, Suggestions, confirmHeight } from './parts.jsx';
import { InboxView } from './InboxView.jsx';
import { PipelinesView, pipelineId } from './PipelinesView.jsx';
import { PrsView, prId } from './PrsView.jsx';
import { ProductionView } from './ProductionView.jsx';
import { ReleasesView } from './ReleasesView.jsx';
import { BoardView } from './BoardView.jsx';
import { TeamView } from './TeamView.jsx';
import { SettingsView } from './SettingsView.jsx';
import { HelpView } from './HelpView.jsx';
import { TextViewer } from './TextViewer.jsx';
import { WorkItemsView, wiId } from './WorkItemsView.jsx';
import { WELCOME_HEIGHT, Welcome } from './Pinch.jsx';

// `short` is what a tab says when the row of tabs doesn't fit the terminal (the widest go short first).
const VIEWS = [
  { id: 'inbox', label: 'Inbox' },
  { id: 'prs', label: 'Pull requests', short: 'PRs' },
  { id: 'pipelines', label: 'Pipelines' },
  { id: 'workitems', label: 'Work items', short: 'Work' },
  { id: 'production', label: 'Production', short: 'Prod' },
  { id: 'releases', label: 'Releases' },
  { id: 'board', label: 'Board' },
  { id: 'team', label: 'Team' },
];

// What ? shows: help.js's sections, then the slash commands.
const HELP_SECTIONS = [...HELP, commandsSection(COMMANDS)];

const HINTS = {
  inbox: '↵ open · s snooze · a/x approve or reject a deployment · o browser',
  prs: 'p publish · a approve · w wait · x reject · c complete · m auto-complete · ↵ more · f filter',
  pipelines: 'n run · c cancel the run · l the run in full, with logs · ↵ all runs · o browser',
  workitems: 's state · i take it · b blocked · ↵ more · f next view · /assign /priority /comment /new',
  production: '↵ everything, and all that is waiting to ship · o open the site',
  releases: 'n new release · d deploy to a stage · a/x approve or reject · D download a GitHub release file · ↵ everything · o browser',
  board: 'h/l column · < > move the card · m move to… · space done · ↵ more · s i b · t team · v board · f sprint',
  team: '↵ their work items · p their pull requests · /find a name',
};
const SETTINGS_HINT = "tab next section · space change · - + a number · ↵ a project's repos · /find a project · esc close";

const firstLine = (s) => String(s ?? '').split('\n')[0];
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const segmentsText = (line) => (typeof line === 'string' ? line : line.map((s) => s.text).join(''));

function Header({ meta, orgs, signIn, server, attention, pollError, width, mood }) {
  const segs = [
    { text: `${FACES[mood]} `, color: mood === 'worried' ? theme.warn : theme.accent, bold: true },
    { text: 'Keel', bold: true },
    { text: '  │  ', color: theme.border },
  ];
  const primary = orgs[0];
  segs.push({ text: primary?.name ?? 'Azure DevOps', bold: true });
  if (orgs.length > 1) segs.push({ text: ` +${orgs.length - 1}`, color: theme.dim });
  if (meta) segs.push({ text: `  ${plural(meta.trackedProjects.length, 'project')}`, color: theme.dim });
  if (signIn === 'demo') segs.push({ text: '  ' }, { text: ' DEMO ', bg: theme.warn, color: theme.ink, bold: true });
  else if (signIn === 'keel') segs.push({ text: `  ${meta?.account?.name ?? 'signed in'} · ${server.replace(/^https?:\/\//, '')}`, color: theme.dim });
  else segs.push({ text: signIn === 'az' ? '  az login' : '  PAT', color: theme.dim });
  const high = attention?.summary?.high;
  if (high) segs.push({ text: '  ' }, { text: ` ${high} act now `, bg: theme.del, color: theme.ink, bold: true });
  if (pollError) segs.push({ text: "  can't reach Azure DevOps", color: theme.del });
  return <Row pointer={false} width={width} segments={fitSegments(segs, width)} />;
}

/**
 * Each tab's label and the columns it covers in the tab row (where a click lands), with its count.
 * When they don't all fit `width`, the widest labels give way to their short ones until they do.
 */
function tabLabels(data, width = Infinity) {
  const counts = {
    inbox: data.attention?.items.length,
    prs: data.prs?.filter((p) => p.needsMyReview).length || null,
    pipelines: data.pipelines?.filter((p) => p.health === 'failing').length || null,
    // Yours, as the Inbox counts what needs you.
    workitems: data.workItems?.items.filter((w) => data.workItems.me && w.assignedTo?.id === data.workItems.me.id).length || null,
    production: data.production?.monitors.filter((m) => m.state === 'down' || m.state === 'degraded').length || null,
  };
  const names = VIEWS.map((v) => v.label);
  const labelOf = (i) => ` ${i + 1} ${names[i]}${counts[VIEWS[i].id] ? ` ${counts[VIEWS[i].id]}` : ''} `;
  const total = () => names.reduce((sum, _, i) => sum + stringWidth(labelOf(i)) + 1, 0);
  const widest = VIEWS.map((v, i) => i).filter((i) => VIEWS[i].short).sort((p, q) => VIEWS[q].label.length - VIEWS[p].label.length);
  for (const i of widest) {
    if (total() <= width) break;
    names[i] = VIEWS[i].short;
  }
  let x = 0;
  return VIEWS.map((v, i) => {
    const label = labelOf(i);
    const from = x;
    x += stringWidth(label) + 1;
    return { id: v.id, label, from, to: from + stringWidth(label) };
  });
}

function Tabs({ view, data, width }) {
  const segs = [];
  for (const t of tabLabels(data, width)) {
    const on = t.id === view;
    segs.push({ text: t.label, bg: on ? theme.accent : undefined, color: on ? theme.ink : theme.dim, bold: on }, { text: ' ' });
  }
  return <Row pointer={false} width={width} segments={segs} />;
}

const DOUBLE_CLICK_MS = 400;
// What a mouse selection copied: "3 lines", "12 characters".
const copiedText = (text) => {
  const n = text.split('\n').length;
  return n > 1 ? `${n} lines` : plural(text.length, 'character');
};

// The last two results, Claude Code style: "● Approve !817 …" then "  ⎿  Approved."
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

/**
 * `keel` is `{ service, orgs, signIn, live, orgAdmin }` from cli/service.js (the tests build it the
 * same way, on demo data), or from cli/remote.js when signed in to a Keel server (with `server`
 * and `logout` too). `openUrl` opens links (the browser by default); `openSonar` opens Sonar on a production
 * monitor (sonar.js's; tests pass a recorder); `poll` turns live checks off when false.
 * `checkUpdate` and `installUpdate` (cli/update.js) are only passed to the downloaded executable, and
 * only when its .env lets it check (and install) by itself; `updater` ({ check, install }) is passed to
 * it always, for /update.
 * `envFile` is the .env this Keel reads, where Settings saves this computer's choices. `mouse` is
 * mouse.js's terminalMouse() from cli.jsx (missing where the terminal can't report it); tests pass their own.
 */
export function App({ keel, openUrl = openInBrowser, openSonar = openSonarApp, poll = true, checkUpdate, installUpdate, updater, envFile = path.join(ROOT, '.env'), mouse }) {
  const { service, orgs, signIn, live } = keel;
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize();
  const [meta, setMetaState] = useState(null);
  const [data, setDataState] = useState({ attention: null, prs: null, pipelines: null, workItems: null, production: null, version: 0 });
  const [pollError, setPollError] = useState(null);
  const [view, setViewState] = useState('inbox');
  const [focus, setFocusState] = useState('view');
  const [prompt, setPromptState] = useState({ value: '', cursor: 0 });
  const [sugIndex, setSugIndex] = useState(0);
  const [overlay, setOverlayState] = useState(null);
  const [confirmReq, setConfirmReq] = useState(null);
  const [entries, setEntries] = useState([]);
  const [busy, setBusy] = useState(null);
  const [filters, setFilters] = useState({ inbox: '', prs: '', pipelines: '', workitems: '', production: '', releases: '', board: '', team: '', settings: '' });
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  // What Settings shows about this computer; `envTick` moves when its .env changes.
  const [envTick, setEnvTick] = useState(0);
  const local = React.useMemo(() => ({ envFile, signIn, server: keel.server, account: keel.account, compiled: COMPILED, mouseAvailable: Boolean(mouse), env: { ...process.env } }), [envFile, signIn, envTick]);
  // A word in the bottom line for a moment ("Copied 3 lines"), where it moves nothing on screen.
  const [flash, setFlash] = useState(null);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 3000);
    return () => clearTimeout(t);
  }, [flash]);
  const [show, setShow] = useState('all');
  // The work item view, as the web app's (format.js wiViews).
  const [wiShow, setWiShow] = useState('all');
  const [jump, setJump] = useState(null);
  const [welcome, setWelcome] = useState(true);
  // A newer release: { latest, url, state: 'out' | 'installing' | 'installed' }.
  const [update, setUpdate] = useState(null);
  // Pinch looks happy (or worried) for a few seconds after a result; re-render when that wears off.
  const [, setMoodTick] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setMoodTick((n) => n + 1), 8100);
    return () => clearTimeout(t);
  }, [entries]);

  // Async actions read the latest state through refs, not through stale closures.
  const metaRef = useRef(null);
  const dataRef = useRef(data);
  const viewRef = useRef('inbox');
  const busyRef = useRef(null);
  const promptRef = useRef(prompt);
  const confirmRef = useRef(null);
  const focusRef = useRef('view');
  const overlayRef = useRef(null);
  const selection = useRef({});
  const nextId = useRef(1);
  const history = useRef([]);
  const historyPos = useRef(-1);
  const lastOutput = useRef(null);
  const loading = useRef(null);

  const setMeta = (m) => {
    metaRef.current = m;
    setMetaState(m);
  };
  const setData = (patch) => {
    dataRef.current = { ...dataRef.current, ...patch, version: dataRef.current.version + 1 };
    setDataState(dataRef.current);
  };
  const setView = (v) => {
    viewRef.current = v;
    setViewState(v);
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
    setEntries((list) => [...list.slice(-19), { id, lines: [], at: Date.now(), ...e }]);
    return id;
  };
  const updateEntry = (id, patch) => setEntries((list) => list.map((e) => (e.id === id ? { ...e, at: Date.now(), ...patch } : e)));

  const note = (text, status = 'info') => {
    const [title, ...lines] = String(text).split('\n');
    addEntry({ title, status, lines });
  };

  // Everything the tabs show, read together. Several callers at once share one read.
  const load = () => {
    loading.current ??= Promise.all([service.attention(), service.pullRequests(), service.pipelines(), service.workItems(), service.production()])
      .then(([attention, prs, pipelines, workItems, production]) => {
        setData({ attention, prs: prs.prs, pipelines, workItems, production });
        setPollError(null);
      })
      .finally(() => {
        loading.current = null;
      });
    return loading.current;
  };

  // After a change of ours: read again (the service already dropped what the change touched).
  const reload = () => load();
  // After a settings change: also who you are and what's tracked (the header counts projects).
  const reloadAll = async () => {
    setMeta(await service.meta());
    await load();
  };

  const showNotes = (notes) => {
    for (const n of notes.slice(0, 5)) addEntry({ title: n.title, status: 'info', lines: n.body ? [n.body] : [] });
    if (notes.length > 5) note(`… and ${notes.length - 5} more changes in Azure DevOps.`);
  };

  // A live check, as the web server's watcher does: ask Azure DevOps again, tell what changed.
  // (Through a Keel server, it asks the server to look now, and what changed arrives on its stream.)
  const check = async () => {
    const notes = await live.check();
    await load();
    showNotes(notes);
  };

  // One thing at a time, with the spinner, esc to stop waiting, and a line in the activity log.
  // `start(signal)` resolves with the lines to show under the title.
  const task = async (title, start, { label = 'Working', quiet = false } = {}) => {
    if (busyRef.current) {
      note(`Wait for "${busyRef.current.label}" to finish (esc stops waiting).`, 'error');
      return { ok: false, error: new Error('busy') };
    }
    const controller = new AbortController();
    const b = { label, started: Date.now(), abort: () => controller.abort() };
    busyRef.current = b;
    setBusy(b);
    const id = quiet ? null : addEntry({ title, status: 'running' });
    if (!quiet) setWelcome(false);
    // Esc stops waiting; Azure DevOps may still finish what was asked, and the next check shows it.
    const stopped = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(Object.assign(new Error('Stopped waiting'), { cancelled: true }))));
    try {
      const lines = await Promise.race([start(controller.signal), stopped]);
      lastOutput.current = { title, text: lines.join('\n') || 'Done' };
      if (id) updateEntry(id, { status: 'ok', lines: lines.length ? lines : ['Done'] });
      return { ok: true };
    } catch (error) {
      const lines = error.cancelled ? ['Stopped waiting. Azure DevOps may still finish it: r checks again.'] : String(error.message).split('\n');
      lastOutput.current = { title, text: lines.join('\n') };
      if (id) updateEntry(id, { status: 'error', lines });
      else addEntry({ title, status: 'error', lines });
      return { ok: false, error };
    } finally {
      busyRef.current = null;
      setBusy(null);
    }
  };

  const refresh = () =>
    task('Check Azure DevOps', async () => {
      await check();
      const att = dataRef.current.attention;
      return [`${plural(att.items.length, 'item')} in the Inbox · ${plural(dataRef.current.prs.length, 'pull request')} · ${plural(dataRef.current.pipelines.length, 'pipeline')}`];
    }, { label: 'Asking Azure DevOps' });

  const confirm = (req) =>
    new Promise((done) => {
      const full = { options: [{ label: 'Yes', value: true }, { label: 'No', value: false }], ...req, id: nextId.current++, done };
      confirmRef.current = full;
      setConfirmReq(full);
    });
  const onConfirm = (value) => {
    const req = confirmRef.current;
    setConfirmReq(null);
    // The key that answered goes on to the tabs' handlers too: until it has, the question still
    // counts as open, so a "1" picking the first choice doesn't also switch to the Inbox.
    setTimeout(() => {
      if (confirmRef.current === req) confirmRef.current = null;
    }, 0);
    req?.done(value);
  };

  const prefill = (text, cursor = text.length) => {
    setPrompt(text, cursor);
    setSugIndex(0);
    historyPos.current = -1;
    setFocus('prompt');
  };

  // What slash commands act on: the selection in the current tab. A pull request, work item or
  // pipeline picked in the Inbox counts as that pull request, work item or pipeline.
  const current = () => {
    const sel = selection.current;
    const v = viewRef.current;
    const d = dataRef.current;
    if (overlayRef.current?.settings) return { setting: sel.setting, webUrl: sel.setting?.org?.url ?? sel.setting?.project?.webUrl };
    if (v === 'prs') return { pr: sel.pr, webUrl: sel.pr?.webUrl };
    if (v === 'pipelines') return { pipeline: sel.pipeline, webUrl: sel.pipeline?.lastRun?.webUrl ?? sel.pipeline?.latest?.webUrl };
    if (v === 'workitems') return { workItem: sel.workItem, webUrl: sel.workItem?.webUrl };
    if (v === 'production') return { monitor: sel.monitor, webUrl: sel.monitor?.url?.replace(/\/health\/?$/i, '') || undefined };
    if (v === 'releases') return { release: sel.release, releaseApprovals: sel.releaseApprovals, webUrl: sel.release?.webUrl };
    // A card is a work item: /state, /assign, /comment and the rest act on it.
    if (v === 'board') return { workItem: sel.workItem, webUrl: sel.workItem?.webUrl };
    if (v === 'team') return { person: sel.person };
    const item = sel.item;
    const t = item?.target ?? {};
    const sameOrg = (x) => !item.org || !x.org || x.org === item.org;
    const pr = t.type === 'pr' ? d.prs?.find((p) => p.projectId === t.projectId && p.repoId === t.repoId && p.id === t.id && sameOrg(p)) : undefined;
    const pipeline = t.type === 'pipeline' ? d.pipelines?.find((p) => p.key === t.key && sameOrg(p)) : undefined;
    const workItem = t.type === 'workitem' ? d.workItems?.items.find((w) => w.id === t.id && sameOrg(w)) : undefined;
    return { item, pr, pipeline, workItem, webUrl: item?.webUrl };
  };

  const quit = () => exit();

  const ctxRef = useRef(null);
  if (!ctxRef.current) {
    ctxRef.current = {
      // What useMouse registers: the component on screen takes the main area's clicks and wheel.
      mouseHandlers: [],
      get meta() {
        return metaRef.current;
      },
      get data() {
        return dataRef.current;
      },
    };
  }
  const ctx = ctxRef.current;
  Object.assign(ctx, {
    service,
    task,
    confirm,
    note,
    prefill,
    reload,
    reloadAll,
    refresh,
    envFile,
    orgAdmin: keel.orgAdmin,
    server: keel.server,
    logout: keel.logout,
    saveEnv: (lines) => {
      saveEnvSettings(envFile, lines);
      setEnvTick((n) => n + 1);
    },
    // Settings opens over the current tab, as an overlay; esc closes it.
    showSettings: () => setOverlay({ settings: true }),
    settingsHasKeys: () => focusRef.current === 'view' && !!overlayRef.current?.settings && !confirmRef.current,
    current,
    openUrl,
    openSonar,
    quit,
    select: (patch) => Object.assign(selection.current, patch),
    // ↵ on an Inbox item: its pull request or pipeline in its own tab, when it's in the list.
    showPr: (target, org) => {
      const pr = dataRef.current.prs?.find((p) => p.projectId === target.projectId && p.repoId === target.repoId && p.id === target.id && (!org || !p.org || p.org === org));
      if (!pr) return false;
      setFilters((f) => ({ ...f, prs: '' }));
      setShow('all');
      setJump({ view: 'prs', key: prId(pr) });
      setView('prs');
      return true;
    },
    showPipeline: (key, org) => {
      const row = dataRef.current.pipelines?.find((p) => p.key === key && (!org || !p.org || p.org === org));
      if (!row) return false;
      setFilters((f) => ({ ...f, pipelines: '' }));
      setJump({ view: 'pipelines', key: pipelineId(row) });
      setView('pipelines');
      return true;
    },
    // Open work items only: the list is what Keel reads (closed ones open in the browser).
    showWorkItem: (id, org) => {
      const w = dataRef.current.workItems?.items.find((x) => x.id === Number(id) && (!org || !x.org || x.org === org));
      if (!w) return false;
      setFilters((f) => ({ ...f, workitems: '' }));
      setWiShow('all');
      setJump({ view: 'workitems', key: wiId(w) });
      setView('workitems');
      return true;
    },
    showTab: (id) => setView(id),
    // ↵ and p in Team: everything open of theirs, in the Work items or Pull requests tab.
    showWorkItemsOf: (person) => {
      setFilters((f) => ({ ...f, workitems: person.displayName }));
      setWiShow('all');
      setView('workitems');
    },
    showPrsOf: (person) => {
      setFilters((f) => ({ ...f, prs: person.displayName }));
      setShow('all');
      setView('prs');
    },
    jumped: () => setJump(null),
    find: (text) => {
      const v = overlayRef.current?.settings ? 'settings' : viewRef.current;
      setFilters((f) => ({ ...f, [v]: text.trim() }));
    },
    // F and /filter (actions.js pickFilter): this tab's filter text, and the list it narrows, which
    // each view hands over as { tab, items } (the tab's id, so another tab's leftover list never counts).
    currentFilter: () => filtersRef.current[overlayRef.current?.settings ? 'settings' : viewRef.current] ?? '',
    filterSource: () => {
      const src = selection.current.filterSource;
      return src && src.tab === viewRef.current && !overlayRef.current ? src : null;
    },
    // /show and f: which pull requests (all, review, mine), or which work item view, by the tab you're on.
    showView: (tab, value) => {
      if (tab === 'workitems') {
        if (!WI_VIEW_IDS.includes(value)) return note(`Show ${WI_VIEW_IDS.join(', ')}.`, 'error');
        setWiShow(value);
      } else {
        if (!['all', 'review', 'mine'].includes(value)) return note('Show all, review or mine.', 'error');
        setShow(value);
      }
      setView(tab);
    },
    showGroup: (value) => ctx.showView(viewRef.current === 'workitems' ? 'workitems' : 'prs', value),
    viewHasKeys: () => focusRef.current === 'view' && !overlayRef.current && !confirmRef.current,
    showText: (title, text) => setOverlay({ title, text }),
    showPrFull: async (pr) => {
      setOverlay({ title: `!${pr.id} ${pr.title}`, loading: true });
      try {
        const full = await service.pullRequest(pr.projectId, pr.repoId, pr.id);
        setOverlay((o) => (o?.title === `!${pr.id} ${pr.title}` ? { title: o.title, text: prFullText(full) } : o));
      } catch (e) {
        setOverlay(null);
        note(`Couldn't read !${pr.id}: ${firstLine(e.message)}`, 'error');
      }
    },
    showWorkItemFull: async (w) => {
      const title = `${w.type} ${w.id} ${w.title}`;
      setOverlay({ title, loading: true });
      try {
        const full = await service.workItem(w.id, w.org);
        setOverlay((o) => (o?.title === title ? { title, text: wiFullText(full) } : o));
      } catch (e) {
        setOverlay(null);
        note(`Couldn't read ${w.type} ${w.id}: ${firstLine(e.message)}`, 'error');
      }
    },
    showMonitorFull: (m, target) => setOverlay({ title: m.name, text: monitorFullText(m, target) }),
    showReleaseFull: (d, approvals) => setOverlay({ title: d.name, text: isGithubRelease(d) ? githubFullText(d) : releaseFullText(d, approvals) }),
    showPipelineRuns: async (row) => {
      setOverlay({ title: row.definition.name, loading: true });
      try {
        const { runs } = await service.pipelineRuns(row.projectId, row.definition.id);
        setOverlay((o) => (o?.title === row.definition.name ? { title: o.title, text: pipelineDetail(row, runs).map(segmentsText).join('\n') } : o));
      } catch (e) {
        setOverlay(null);
        note(`Couldn't read the runs of ${row.definition.name}: ${firstLine(e.message)}`, 'error');
      }
    },
    // On the section for the view on screen.
    showHelp: () => setOverlay({ help: true, start: sectionFor(HELP_SECTIONS, view) }),
    showLog: () => setOverlay({ title: 'Log', text: logText() }),
    showLast: () => (lastOutput.current ? setOverlay({ ...lastOutput.current }) : note('Nothing has run yet.')),
    // /update: asks GitHub for the latest release now, whatever the daily check last said, and installs it.
    updateNow: () => {
      if (!updater) {
        return note(process.platform === 'browser'
          ? `This is the web app's terminal (Keel ${VERSION}): it's as new as the web app.`
          : `This Keel (${VERSION}) runs from a checkout: git pull updates it.`);
      }
      if (update?.state === 'installing') return note(`Keel ${update.latest} is being installed already.`);
      if (update?.state === 'installed') return note(`Keel ${update.latest} is installed. It starts the next time you open Keel.`);
      return task('Look for a new version of Keel', async () => {
        const { checked, newer } = await updater.check();
        if (!newer) return [`Keel ${VERSION} is the latest version.`];
        setUpdate({ ...checked, state: 'installing' });
        try {
          await updater.install(checked.latest);
        } catch (e) {
          setUpdate({ ...checked, state: 'out' });
          throw new Error(`Keel ${checked.latest} is out, but it couldn't be installed: ${firstLine(e.message)}\nDownload it from ${checked.url}`);
        }
        setUpdate({ ...checked, state: 'installed' });
        return [`Keel ${checked.latest} is installed. It starts the next time you open Keel.`];
      }, { label: 'Updating Keel' });
    },
  });

  const submit = async (raw) => {
    const text = raw.trim();
    setPrompt('');
    setFocus('view');
    if (!text) return;
    history.current = [text, ...history.current.filter((h) => h !== text)].slice(0, 100);
    try {
      const [, name, rest] = text.replace(/^\//, '').match(/^(\S+)\s*([\s\S]*)$/);
      const cmd = findCommand(name);
      if (!cmd) return note(`Unknown command: /${name}. Type / to see them all.`, 'error');
      await cmd.run(ctx, rest.trim());
    } catch (e) {
      note(firstLine(e.message), 'error');
    }
  };

  // First look: who you are and your tracked projects, then everything the tabs show, and the
  // baseline the live checks compare against (the first one announces nothing, as in the browser).
  useEffect(() => {
    let on = true;
    (async () => {
      try {
        const m = await service.meta();
        if (!on) return;
        setMeta(m);
        await load();
        await live.baseline();
      } catch (e) {
        if (!on) return;
        setPollError(firstLine(e.message));
        note(`Couldn't read Azure DevOps: ${firstLine(e.message)}`, 'error');
      }
      // After the first load, so it doesn't slow it down. Tests leave these out (or pass stubs), so
      // they stay offline and never replace anything.
      if (on && checkUpdate) {
        checkUpdate().then(
          ({ checked, newer }) => {
            if (!on || !newer) return;
            const outNote = (why = '') => note(`Keel ${checked.latest} is out (you have ${VERSION})${why}.\nDownload it from ${checked.url}`);
            if (!installUpdate) {
              setUpdate({ ...checked, state: 'out' });
              return outNote();
            }
            // In the background, without the spinner: nothing waits on it, and it only counts from the next start.
            setUpdate({ ...checked, state: 'installing' });
            return installUpdate(checked.latest).then(
              () => {
                setUpdate({ ...checked, state: 'installed' });
                note(`Keel ${checked.latest} is installed. It starts the next time you open Keel.`);
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
    return () => {
      on = false;
    };
  }, []);

  // Live checks, every "refresh every" seconds from Keel's settings (as the web app's), only
  // between other things: never while an action runs. Through a Keel server, the server checks
  // and its event stream says when something changed.
  useEffect(() => {
    if (!poll) return;
    if (live.stream) {
      return live.stream({
        changed: () => load().catch((e) => setPollError(firstLine(e.message))),
        notify: showNotes,
        status: (s) => setPollError(s.ok ? null : firstLine(s.error)),
      });
    }
    let timer = null;
    let on = true;
    const next = async () => {
      const seconds = await live.interval();
      if (on) timer = setTimeout(tick, seconds * 1000);
    };
    const tick = async () => {
      if (!busyRef.current) {
        try {
          await check();
        } catch (e) {
          setPollError(firstLine(e.message));
        }
      }
      if (on) next();
    };
    next();
    return () => {
      on = false;
      clearTimeout(timer);
    };
  }, []);

  const lists = { prs: data.prs, workItems: data.workItems, view };
  const suggestions = focus === 'prompt' && !confirmReq ? suggestionsFor(prompt.value, lists) : [];
  const sel = Math.min(sugIndex, Math.max(0, suggestions.length - 1));

  // Line editing in the prompt.
  const promptKeys = (input, key) => {
    const { value, cursor } = promptRef.current;
    const items = suggestionsFor(value, { prs: dataRef.current.prs, workItems: dataRef.current.workItems, view: viewRef.current });
    const pick = items[Math.min(sugIndex, items.length - 1)];
    const edit = (v, c) => {
      setPrompt(v, c);
      setSugIndex(0);
    };
    if (key.ctrl && input === 'c') return value ? edit('', 0) : quit();
    if (key.escape) return setFocus('view');
    if (key.return) {
      if (pick && value.trim() !== pick.insert.trim()) return pick.run ? submit(pick.insert) : edit(pick.insert);
      return submit(value);
    }
    if (key.tab) return pick ? edit(pick.insert) : undefined;
    if (key.upArrow || key.downArrow) {
      if (items.length) return setSugIndex((s) => (s + (key.upArrow ? items.length - 1 : 1)) % items.length);
      const pos = Math.max(-1, Math.min(history.current.length - 1, historyPos.current + (key.upArrow ? 1 : -1)));
      historyPos.current = pos;
      return setPrompt(pos < 0 ? '' : history.current[pos]);
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

  // Over Settings: esc closes it (or stops waiting), the prompt and o still work; the rest is the overlay's.
  const settingsKeys = (input, key) => {
    if (key.escape) return busyRef.current ? busyRef.current.abort() : setOverlay(null);
    if (key.ctrl || key.meta) return;
    if (input[0] === '/' || input[0] === ':') return prefill(`/${input.slice(1).replace(/[\x00-\x1f\x7f]/g, '')}`);
    if (input === 'o') return a.open(ctx);
  };

  // Keys that work in every view.
  const globalKeys = (input, key) => {
    if (key.escape) {
      if (busyRef.current) busyRef.current.abort();
      else {
        setEntries([]);
        setWelcome(false);
      }
      return;
    }
    if (key.ctrl || key.meta) return;
    // A pasted "/approve" arrives in one piece: it starts the prompt with all of it.
    if (input[0] === '/' || input[0] === ':') return prefill(`/${input.slice(1).replace(/[\x00-\x1f\x7f]/g, '')}`);
    if (input === '?') return ctx.showHelp();
    if (input === 'q') return quit();
    if (input === 'o') return a.open(ctx);
    if (input === ',') return ctx.showSettings();
    const n = Number(input);
    if (n >= 1 && n <= VIEWS.length) return setView(VIEWS[n - 1].id);
    if (key.tab) {
      const i = VIEWS.findIndex((v) => v.id === viewRef.current);
      return setView(VIEWS[(i + (key.shift ? VIEWS.length - 1 : 1)) % VIEWS.length].id);
    }
    if (input === 'r') return refresh();
  };

  // One dispatcher reading focus from refs, which change the instant focus moves. Handlers that
  // switch on with the next render would let fast typing (or a paste) after "/" leak into the view.
  useInput((input, key) => {
    if (focusRef.current === 'prompt' && !confirmRef.current) return promptKeys(input, key);
    if (key.ctrl && input === 'c') return quit();
    if (confirmRef.current) return;
    if (overlayRef.current?.settings) return settingsKeys(input, key);
    if (overlayRef.current) return;
    globalKeys(input, key);
  });

  // The terminal reports the mouse unless this computer's Settings turned it off (KEEL_MOUSE=0).
  useEffect(() => {
    mouse?.enable(mouseOn(local.env));
  }, [local]);

  // Where things were drawn, for matching clicks against (set as the layout below is worked out).
  const layout = useRef(null);
  const lastPress = useRef(null);
  // The component under a point of the main area (`y` counted from its top), and that `y` in it.
  const mouseTarget = (y) => {
    const target = ctx.mouseHandlers.findLast((h) => h.top <= y);
    return target && { target, y: y - target.top };
  };
  const onMouse = (e) => {
    if (e.type === 'copy') return setFlash({ text: `Copied ${copiedText(e.text)}` });
    if (e.button === 'left' && !e.release && !e.drag) {
      const prev = lastPress.current;
      const now = Date.now();
      const count = prev && prev.x === e.x && prev.y === e.y && now - prev.at < DOUBLE_CLICK_MS ? prev.count + 1 : 1;
      e.double = count === 2;
      lastPress.current = count < 2 ? { x: e.x, y: e.y, at: now, count } : null;
    } else if (e.button !== 'wheel') return;
    // A question's options take keys only.
    if (confirmRef.current || !layout.current) return;
    const { mainTop, mainH, promptTop, sugCount, tabs } = layout.current;
    if (e.y === mainTop - 1 && !e.wheel) {
      const tab = tabs.find((t) => e.x >= t.from && e.x < t.to);
      if (!tab) return;
      // Whatever is open over the tab closes: a click on a tab should never do nothing.
      if (overlayRef.current) setOverlay(null);
      if (focusRef.current === 'prompt') setFocus('view');
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

  // Layout: everything is sized to the terminal, one row short of it so Ink never clears the screen.
  const W = columns;
  const H = Math.max(12, rows - 1);
  const act = activityRows(entries);
  const bottom = confirmReq ? confirmHeight(confirmReq) : 3 + suggestions.length;
  const mood = moodFor({ attention: data.attention, busy, lastEntry: entries.at(-1), pollError });
  // The welcome box only appears when the terminal has room for it next to a useful view.
  const showWelcome = welcome && H >= 28;
  const mainH = Math.max(6, H - 2 - act.length - (busy ? 1 : 0) - bottom - 1 - (showWelcome ? WELCOME_HEIGHT : 0));
  const viewActive = focus === 'view' && !overlay && !confirmReq;
  layout.current = {
    mainTop: 2,
    mainH,
    promptTop: 2 + mainH + (showWelcome ? WELCOME_HEIGHT : 0) + act.length + (busy ? 1 : 0),
    sugCount: suggestions.length,
    tabs: tabLabels(data, W),
  };

  let main;
  if (overlay?.settings) {
    main = <SettingsView version={data.version} orgs={orgs} local={local} filter={filters.settings} ctx={ctx} width={W} height={mainH} active={focus === 'view' && !confirmReq} />;
  } else if (overlay?.help) {
    main = <HelpView sections={HELP_SECTIONS} start={overlay.start} ctx={ctx} width={W} height={mainH} active={focus === 'view' && !confirmReq} onClose={() => setOverlay(null)} />;
  } else if (overlay) {
    main = <TextViewer {...overlay} ctx={ctx} width={W} height={mainH} active={focus === 'view' && !confirmReq} onClose={() => setOverlay(null)} />;
  } else if (view === 'prs') {
    main = <PrsView failed={Boolean(pollError)} prs={data.prs} show={show} filter={filters.prs} jump={jump?.view === 'prs' ? jump.key : null} ctx={ctx} width={W} height={mainH} active={viewActive} />;
  } else if (view === 'workitems') {
    main = <WorkItemsView failed={Boolean(pollError)} workItems={data.workItems} meta={meta} show={wiShow} filter={filters.workitems} jump={jump?.view === 'workitems' ? jump.key : null} ctx={ctx} width={W} height={mainH} active={viewActive} />;
  } else if (view === 'production') {
    main = <ProductionView failed={Boolean(pollError)} production={data.production} version={data.version} filter={filters.production} ctx={ctx} width={W} height={mainH} active={viewActive} />;
  } else if (view === 'team') {
    main = <TeamView version={data.version} workItems={data.workItems} prs={data.prs} filter={filters.team} ctx={ctx} width={W} height={mainH} active={viewActive} />;
  } else if (view === 'board') {
    main = <BoardView version={data.version} filter={filters.board} meta={meta} ctx={ctx} width={W} height={mainH} active={viewActive} />;
  } else if (view === 'releases') {
    main = <ReleasesView version={data.version} filter={filters.releases} ctx={ctx} width={W} height={mainH} active={viewActive} />;
  } else if (view === 'pipelines') {
    main = <PipelinesView failed={Boolean(pollError)} pipelines={data.pipelines} version={data.version} filter={filters.pipelines} jump={jump?.view === 'pipelines' ? jump.key : null} ctx={ctx} width={W} height={mainH} active={viewActive} />;
  } else {
    main = <InboxView failed={Boolean(pollError)} attention={data.attention} filter={filters.inbox} ctx={ctx} width={W} height={mainH} active={viewActive} />;
  }

  const left = flash ? flash.text : focus === 'prompt' ? 'enter run · tab complete · ↑↓ pick or history · esc back' : overlay?.settings ? SETTINGS_HINT : overlay?.help ? 'j/k section · space scroll · / search · esc close' : overlay ? 'j/k scroll · space page · esc close' : HINTS[view];
  const right = focus === 'prompt' ? '' : '  / commands · ? help';

  return (
    <Box flexDirection="column" width={W} height={H}>
      <Header meta={meta} orgs={orgs} signIn={signIn} server={keel.server ?? ''} attention={data.attention} pollError={pollError} width={W} mood={mood} />
      <Tabs view={view} data={data} width={W} />
      <Box height={mainH} width={W}>
        {main}
      </Box>
      {showWelcome ? <Welcome mood={mood} attention={data.attention} pollError={pollError} update={update} width={W} /> : null}
      {act.map((segs, i) => (
        <Row key={i} pointer={false} width={W} segments={segs} />
      ))}
      {busy ? <Spinner label={busy.label} started={busy.started} width={W} /> : null}
      {confirmReq ? (
        <Confirm key={confirmReq.id} req={confirmReq} width={W} onDone={onConfirm} />
      ) : (
        <PromptBox value={prompt.value} cursor={prompt.cursor} focused={focus === 'prompt'} width={W} placeholder="Press / for commands (try /approve or /run), ? for shortcuts" />
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
