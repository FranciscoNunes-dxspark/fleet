// The host's panels over the apps: the runbooks (ctrl+] r: a picker, then a runbook whose steps
// are handed to their apps one ↵ at a time), following a request (ctrl+] f: an id, asked of every
// running app that reads log lines, and a timeline of what Fleet finds itself), moving the fleet (m),
// the project's environments (e), what changed lately (w, and Claude's take on why something broke)
// Claude's proposals (P: lines handed to their apps as runbook steps are) and the security overview
// (S: every app's security check for the project, security.js). Each is an object with
// `render(size)` (the box, as ANSI text placed on screen) and `keys(text)`; the host shows one at a
// time (Host.showOverlay) and gives it every key while it's open. What they do to the apps goes back
// through the host: `sendLine` (a hand-off), `typeInto` (a line into a prompt, off screen), `switchTo`.
import { join, relative } from 'node:path';
import { ask as askClaude, clip } from '@fleet/kit/claude-cli.js';
import { currentEnvironment, readProject, setEnvironment } from '@fleet/kit/environments.js';
import { APP_NAMES, familyDir as kitFamilyDir, readActivity, TAKEN_BY } from '@fleet/kit/family.js';
import { keyLength } from './keys.js';
import { boxRows, boxSize, changesLines, envLines, folderLines, pickerLines, placeBox, proposalLines, runbookLines, securityLines, traceAskLines, traceLines } from './overlay.js';
import { COMPILED } from './app.js';
import { loadOverview, securityConfig, securityOverview } from './security.js';
import { folderPicks, shortFolder } from './folder.js';
import { decideProposal, listProposals } from './proposals.js';
import { draftRunbook, listRunbooks, runbookDirs, writeDraft } from './runbooks.js';
import { bosunHome, traceLine, traceTimeline } from './trace.js';

// What changed reads Splice's git and Bosun's recordings (mcp/changes.js), so it's imported when first asked.
const changesModule = () => import('./mcp/changes.js');
const readChanges = (opts) => changesModule().then((m) => m.whatChanged(opts));

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

/** The keys of `text`, one at a time (an escape sequence whole), as the panels name them. */
export function panelKeys(text) {
  const out = [];
  for (let i = 0; i < text.length; ) {
    const n = keyLength(text, i);
    const k = text.slice(i, i + n);
    i += n;
    if (k === '\x1b[A' || k === '\x1bOA') out.push('up');
    else if (k === '\x1b[B' || k === '\x1bOB') out.push('down');
    else if (k === '\x1b[5~') out.push('pageup');
    else if (k === '\x1b[6~') out.push('pagedown');
    else if (k === '\r' || k === '\n') out.push('enter');
    else if (k === '\x1b') out.push('esc');
    else if (k === '\x7f' || k === '\b') out.push('backspace');
    else if (k === '\x15') out.push('clear');
    else if (/^\x1b\[<[\d;]+[Mm]$/.test(k) || k.startsWith('\x1b')) continue;
    else if (k >= ' ') out.push(k);
  }
  return out;
}

const moveIn = (key, at, count, page = 10) => {
  const by = { up: -1, k: -1, down: 1, j: 1, pageup: -page, pagedown: page }[key];
  return by == null || !count ? null : Math.max(0, Math.min(count - 1, at + by));
};

export class Panels {
  // `cwd` fixes the folder the panels read for (the tests'); by default it's the fleet's, which moves.
  // The family's folder is the host's unless given. `ask` is Claude (the kit's claude-cli.js) and
  // `changes` what changed (mcp/changes.js), both for the tests to replace.
  constructor(host, { cwd, env = process.env, takers = TAKEN_BY.logline, familyDir = host.family?.dir ?? kitFamilyDir(env), bosun = bosunHome(env), now = () => Date.now(), ask = askClaude, changes = readChanges, security = securityOverview, compiled = COMPILED } = {}) {
    Object.assign(this, { host, fixedCwd: cwd, env, takers, familyDir, bosun, now, ask, readChanges: changes, runSecurity: security, compiled });
    this.runbookPanel = new RunbookPanel(this);
    this.tracePanel = new TracePanel(this);
    this.folderPanel = new FolderPanel(this);
    this.envPanel = new EnvironmentPanel(this);
    this.changesPanel = new ChangesPanel(this);
    this.proposalPanel = new ProposalPanel(this);
    this.securityPanel = new SecurityPanel(this);
  }

  get cwd() {
    return this.fixedCwd ?? this.host.cwd ?? process.cwd();
  }

  /** The prefix and e: the project's environments. */
  environments() {
    this.envPanel.open();
  }

  /** The prefix and w: what changed lately. */
  changes() {
    this.changesPanel.open();
  }

  /** The prefix and P: what Claude proposed. */
  proposals() {
    this.proposalPanel.open();
  }

  /** The prefix and S: every app's security check for the project, the last overview until r runs them again. */
  security() {
    this.securityPanel.open();
  }

  /** Opens the runbook in `file` (one just written), the list's cursor on it. */
  openRunbook(file) {
    this.runbookPanel.current = file;
    this.runbookPanel.open();
    this.runbookPanel.cursor = Math.max(0, this.runbookPanel.list.findIndex((r) => r.file === file));
  }

  /** The prefix and m: the folders to move the fleet to. */
  folders() {
    this.folderPanel.open();
  }

  /** ctrl+] r: the runbook you were in, else the picker. */
  runbooks() {
    this.runbookPanel.open();
  }

  /** ctrl+] f: ask for the request to follow. */
  trace() {
    this.tracePanel.open();
  }

  ids() {
    return this.host.spaces.map((s) => s.id);
  }

  box({ title, hint, lines, focus }, size) {
    const box = boxSize(size);
    return placeBox(boxRows({ title, hint, lines, focus, size: box }), box);
  }

  inner(size) {
    return boxSize(size).inner - 1;
  }
}

/** Where to move the fleet: typing a path (the bar's editor), or a folder moved to lately or beside this one. */
class FolderPanel {
  constructor(panels) {
    this.panels = panels;
    this.host = panels.host;
    this.items = [];
    this.cursor = 0;
  }

  open() {
    this.items = folderPicks(this.host.cwd, this.host.folders);
    // The newest folder moved to (not this one) first under the cursor, else typing one.
    this.cursor = this.items.length ? 1 : 0;
    this.host.showOverlay(this);
  }

  render(size) {
    const width = this.panels.inner(size);
    const { lines, focus } = folderLines(this.items, { cursor: this.cursor, width, short: (p) => shortFolder(p, this.host.home) });
    return this.panels.box({ title: `Move the fleet from ${shortFolder(this.host.cwd, this.host.home)}`, hint: '↵ every app starts again there · j k move · esc close', lines, focus }, size);
  }

  keys(text) {
    for (const key of panelKeys(text)) {
      if (key === 'esc') return this.host.closeOverlay();
      const to = moveIn(key, this.cursor, this.items.length + 1);
      if (to != null) this.cursor = to;
      else if (key === 'enter') {
        this.host.closeOverlay();
        if (this.cursor === 0) return this.host.askFolder();
        return this.host.moveTo(this.items[this.cursor - 1].path);
      }
    }
    this.host.showOverlay(this);
  }
}

class RunbookPanel {
  constructor(panels) {
    this.panels = panels;
    this.host = panels.host;
    this.list = [];
    this.cursor = 0;
    this.current = null; // the file of the runbook open, kept between opens
    this.progress = new Map(); // file → { done: Set of step indexes, cursor }
  }

  load() {
    const { cwd, env } = this.panels;
    this.dirs = runbookDirs({ cwd, env });
    this.list = listRunbooks(this.dirs, { cwd, ids: this.panels.ids() });
    this.cursor = Math.min(this.cursor, Math.max(0, this.list.length - 1));
  }

  open() {
    this.load();
    // Read again, so an edit to the file shows; progress stays by step.
    if (this.current && !this.list.some((r) => r.file === this.current)) this.current = null;
    this.host.showOverlay(this);
  }

  runbook() {
    return this.list.find((r) => r.file === this.current) ?? null;
  }

  state(r) {
    if (!this.progress.has(r.file)) this.progress.set(r.file, { done: new Set(), cursor: 0 });
    return this.progress.get(r.file);
  }

  render(size) {
    const width = this.panels.inner(size);
    const r = this.runbook();
    if (!r) {
      const { lines, focus } = pickerLines(this.list, { cursor: this.cursor, width, dirs: this.dirs.map((d) => relative(this.panels.cwd, d) || d), progress: (rb) => this.progress.get(rb.file)?.done.size || null });
      return this.panels.box({ title: 'Runbooks', hint: `${this.list.length ? '↵ open · ' : ''}n draft from the last hour · esc close`, lines, focus }, size);
    }
    const st = this.state(r);
    st.cursor = Math.min(st.cursor, Math.max(0, r.steps.length - 1));
    const { lines, focus } = runbookLines(r, { done: st.done, cursor: st.cursor, width, spaces: this.host.spaces, truecolor: this.host.truecolor });
    return this.panels.box({ title: r.title, hint: '↵ hand it to its app · j k move · l the list · esc close', lines, focus }, size);
  }

  keys(text) {
    for (const key of panelKeys(text)) {
      if (key === 'esc') return this.host.closeOverlay();
      const r = this.runbook();
      if (!r) {
        const to = moveIn(key, this.cursor, this.list.length);
        if (to != null) this.cursor = to;
        else if (key === 'enter' && this.list[this.cursor]) this.current = this.list[this.cursor].file;
        else if (key === 'n') this.draft();
        continue;
      }
      const st = this.state(r);
      const to = moveIn(key, st.cursor, r.steps.length);
      if (to != null) st.cursor = to;
      else if (key === 'l' || key === 'backspace') this.current = null;
      else if (key === 'enter' && r.steps[st.cursor]) return this.hand(r, st);
    }
    this.host.showOverlay(this);
  }

  /** Hands the step under the cursor to its app, as a hand-off, and puts the cursor on the next one not handed yet. */
  hand(r, st) {
    const i = st.cursor;
    st.done.add(i);
    const next = r.steps.findIndex((_, j) => j > i && !st.done.has(j));
    st.cursor = next >= 0 ? next : i;
    const step = r.steps[i];
    this.host.sendLine(step.app, step.line);
  }

  /** n: a draft from the last hour's activity, in the start folder's .fleet/runbooks, with the cursor on it. */
  draft() {
    const now = this.panels.now();
    const entries = readActivity({ dir: this.panels.familyDir, since: now - HOUR, limit: 500 });
    let file;
    try {
      file = writeDraft(join(this.panels.cwd, '.fleet', 'runbooks'), draftRunbook(entries, { now, ids: this.panels.ids() }), { now });
    } catch (e) {
      return this.host.notice(`Couldn't write the draft: ${e.message}`);
    }
    this.load();
    this.cursor = Math.max(0, this.list.findIndex((rb) => rb.file === file));
    this.host.notice(`Drafted ${relative(this.panels.cwd, file) || file}: edit it to add steps`);
  }
}

class TracePanel {
  constructor(panels) {
    this.panels = panels;
    this.host = panels.host;
    this.asking = true;
    this.input = '';
  }

  open() {
    this.asking = true;
    this.input = this.host.lastRequestId ?? this.id ?? '';
    this.host.showOverlay(this);
  }

  render(size) {
    const width = this.panels.inner(size);
    if (this.asking) return this.panels.box({ title: 'Follow a request', hint: '↵ follow · esc close', ...traceAskLines({ input: this.input, width }) }, size);
    const view = traceLines({ id: this.id, asked: this.asked, timeline: this.timeline, cursor: this.cursor, width, spaces: this.host.spaces, truecolor: this.host.truecolor, prefix: this.host.prefixLabel });
    return this.panels.box({ title: `Following ${this.id}`, hint: `${this.asked.length ? '↵ go there · j k move · ' : ''}f another · esc close`, ...view }, size);
  }

  keys(text) {
    for (const key of panelKeys(text)) {
      if (key === 'esc') return this.host.closeOverlay();
      if (this.asking) {
        if (key === 'enter') {
          if (this.input.trim()) this.follow(this.input.trim());
        } else if (key === 'backspace') this.input = [...this.input].slice(0, -1).join('');
        else if (key === 'clear') this.input = '';
        // A character typed or pasted; the named keys are words, never one character.
        else if ([...key].length === 1) this.input += key;
        continue;
      }
      const to = moveIn(key, this.cursor, this.asked.length);
      if (to != null) this.cursor = to;
      else if (key === 'f') this.asking = true;
      else if (key === 'enter' && this.asked[this.cursor]) return this.host.switchTo(this.asked[this.cursor]);
    }
    this.host.showOverlay(this);
  }

  /** Types the request's /take line into every running app that reads log lines, and reads the timeline. */
  follow(id) {
    const { takers, familyDir, bosun } = this.panels;
    this.id = id;
    this.host.lastRequestId = id;
    const line = traceLine(id);
    this.asked = this.host.spaces.filter((s) => s.child && takers.includes(s.id)).map((s) => s.id);
    for (const app of this.asked) this.host.typeInto(app, line);
    this.timeline = traceTimeline(id, { familyDir, bosun, since: this.panels.now() - DAY });
    this.cursor = 0;
    this.asking = false;
  }
}

/** The project's environments: the one chosen marked, ↵ chooses another for every app. */
class EnvironmentPanel {
  constructor(panels) {
    this.panels = panels;
    this.host = panels.host;
    this.cursor = 0;
  }

  open() {
    const { cwd, familyDir } = this.panels;
    this.project = readProject(cwd);
    this.current = currentEnvironment(cwd, { home: familyDir })?.name ?? null;
    this.cursor = Math.max(0, this.project?.names?.indexOf(this.current) ?? 0);
    this.host.showOverlay(this);
  }

  render(size) {
    const width = this.panels.inner(size);
    const names = this.project?.names ?? [];
    const view = envLines({ project: this.project, current: this.current, cursor: this.cursor, width, where: shortFolder(this.panels.cwd, this.host.home) });
    return this.panels.box({ title: 'Environment', hint: `${names.length ? '↵ every app switches · j k move · ' : ''}esc close`, ...view }, size);
  }

  keys(text) {
    for (const key of panelKeys(text)) {
      if (key === 'esc') return this.host.closeOverlay();
      const names = this.project?.names ?? [];
      const to = moveIn(key, this.cursor, names.length);
      if (to != null) this.cursor = to;
      else if (key === 'enter' && names[this.cursor]) return this.choose(names[this.cursor]);
    }
    this.host.showOverlay(this);
  }

  /** Chooses `name` for every app: they watch the choice, and change by themselves. */
  choose(name) {
    const r = setEnvironment(this.panels.cwd, name, { by: 'fleet', home: this.panels.familyDir });
    this.host.closeOverlay();
    this.host.refreshStatus();
    if (!r.ok) return this.host.notice(r.error);
    this.host.notice(r.env.prod ? `Every app is on ${r.env.name} now: production, careful` : `Every app is on ${r.env.name} now`);
  }
}

/**
 * What changed lately in the project, one timeline (mcp/changes.js), the worried moods on top; - and +
 * narrow and widen it (1h, 6h, 24h), and c asks Claude for the likely causes of a symptom: the worried
 * moods' reasons to start from, or what's typed.
 */
class ChangesPanel {
  constructor(panels) {
    this.panels = panels;
    this.host = panels.host;
    this.windows = [1, 6, 24];
    this.hours = 6;
    this.result = null;
    this.cursor = 0;
    this.ask = null; // { input } while a symptom is typed
    this.claude = null; // { state, symptom, text }
    this.reading = 0;
  }

  open() {
    this.ask = null;
    this.load();
    this.host.showOverlay(this);
  }

  /** Reads the timeline again for the window; the panel draws it when it comes, if it's still open. */
  load() {
    const asked = ++this.reading;
    this.result = null;
    this.cursor = 0;
    const { cwd, familyDir, bosun, now } = this.panels;
    const at = now();
    const hours = this.hours;
    Promise.resolve()
      // A window stepped past before it was read (- - typed at once) isn't read at all.
      .then(() => (asked === this.reading ? this.panels.readChanges({ project: cwd, hours, now: at, familyDir, bosun }) : null))
      .catch((e) => ({ project: cwd, since: at - hours * HOUR, now: at, hours, symptoms: [], events: [], notes: [String(e?.message ?? e)] }))
      .then((result) => {
        if (asked !== this.reading || !result) return;
        this.result = result;
        this.redraw();
      });
  }

  redraw() {
    if (this.host.overlay === this) this.host.showOverlay(this);
  }

  render(size) {
    const width = this.panels.inner(size);
    const view = changesLines({ result: this.result, hours: this.hours, windows: this.windows, cursor: this.cursor, ask: this.ask, claude: this.claude, width, spaces: this.host.spaces, truecolor: this.host.truecolor });
    const hint = this.ask ? '↵ ask Claude · esc back' : '- + the window · c ask Claude why · j k move · esc close';
    return this.panels.box({ title: `What changed: the last ${this.hours}h`, hint, ...view }, size);
  }

  keys(text) {
    for (const key of panelKeys(text)) {
      if (this.ask) {
        if (key === 'esc') this.ask = null;
        else if (key === 'enter') {
          if (this.ask.input.trim()) this.askClaude(this.ask.input.trim());
        } else if (key === 'backspace') this.ask.input = [...this.ask.input].slice(0, -1).join('');
        else if (key === 'clear') this.ask.input = '';
        else if ([...key].length === 1) this.ask.input += key;
        continue;
      }
      if (key === 'esc') {
        // Claude's answer would come to a closed panel: it's stopped instead.
        this.abort?.abort();
        this.abort = null;
        if (this.claude?.state === 'asking') this.claude = null;
        return this.host.closeOverlay();
      }
      const i = this.windows.indexOf(this.hours);
      const to = moveIn(key, this.cursor, this.result?.events.length ?? 0);
      if (to != null) this.cursor = to;
      else if ((key === '+' || key === '=') && i < this.windows.length - 1) {
        this.hours = this.windows[i + 1];
        this.load();
      } else if (key === '-' && i > 0) {
        this.hours = this.windows[i - 1];
        this.load();
      } else if (key === 'c' && this.result) {
        // The worried moods are the symptom to start from; the person can say another.
        this.ask = { input: this.result.symptoms.map((m) => `${this.host.space(m.app)?.title ?? APP_NAMES[m.app] ?? m.app}: ${m.reason || m.mood}`).join('; ') };
      }
    }
    this.host.showOverlay(this);
  }

  /** Asks Claude to rank the likely causes of `symptom` from the timeline; the answer shows in the panel. */
  askClaude(symptom) {
    this.ask = null;
    this.abort?.abort();
    const abort = (this.abort = new AbortController());
    this.claude = { state: 'asking', symptom, text: '' };
    const result = this.result;
    changesModule()
      .then(({ causesPrompt, timelineText }) => this.panels.ask(causesPrompt(symptom), { input: clip(timelineText(result)), cwd: this.panels.cwd, signal: abort.signal }))
      .then(
        (text) => ({ state: 'done', symptom, text: String(text ?? '').trim() || 'Claude gave no answer.' }),
        // Not installed says so in the kit's words (claude-cli.js NOT_INSTALLED); cancelled says nothing.
        (e) => (e?.cancelled ? null : { state: 'failed', symptom, text: String(e?.message ?? e) }),
      )
      .then((answer) => {
        if (!answer || this.abort !== abort) return;
        this.abort = null;
        this.claude = answer;
        this.redraw();
      });
  }
}

/** What Claude proposed (proposals.js): ↵ hands a line to its app as a runbook step, x dismisses it. */
class ProposalPanel {
  constructor(panels) {
    this.panels = panels;
    this.host = panels.host;
    this.items = [];
    this.cursor = 0;
  }

  load() {
    this.items = listProposals({ home: this.panels.familyDir, now: this.panels.now(), pending: true });
    this.cursor = Math.min(this.cursor, Math.max(0, this.items.length - 1));
  }

  open() {
    this.load();
    this.host.showOverlay(this);
  }

  render(size) {
    const width = this.panels.inner(size);
    const view = proposalLines(this.items, { cursor: this.cursor, width, spaces: this.host.spaces, truecolor: this.host.truecolor, now: this.panels.now(), prefix: this.host.prefixLabel });
    return this.panels.box({ title: "Claude's proposals", hint: `${this.items.length ? '↵ hand it to its app · x dismiss · j k move · ' : ''}esc close`, ...view }, size);
  }

  keys(text) {
    for (const key of panelKeys(text)) {
      if (key === 'esc') return this.host.closeOverlay();
      const to = moveIn(key, this.cursor, this.items.length);
      const p = this.items[this.cursor];
      if (to != null) this.cursor = to;
      else if (key === 'enter' && p) return this.hand(p);
      else if (key === 'x' && p) {
        decideProposal(p.id, 'dismissed', { home: this.panels.familyDir, now: this.panels.now() });
        this.load();
        this.host.refreshStatus();
      }
    }
    this.host.showOverlay(this);
  }

  /** Types the line into its app's prompt as a hand-off does (Fleet never presses ↵ for it), and says so in its file. */
  hand(p) {
    if (!this.host.space(p.app)) return this.host.notice(`${APP_NAMES[p.app] ?? p.app} doesn't run in Fleet: x dismisses the proposal`);
    decideProposal(p.id, 'handed', { home: this.panels.familyDir, now: this.panels.now() });
    this.host.refreshStatus();
    this.host.sendLine(p.app, p.line);
  }
}

/**
 * The security overview (security.js): the last one kept for the project, or r to run every app's
 * check again (in the background: the panel can close and come back); j k move, ↵ shows a finding's
 * why and fix, esc closes.
 */
class SecurityPanel {
  constructor(panels) {
    this.panels = panels;
    this.host = panels.host;
    this.cursor = 0;
    this.openFinding = false;
    this.running = null;
    this.overview = null;
  }

  root() {
    return securityConfig(this.panels.cwd, { home: this.panels.familyDir }).root;
  }

  open() {
    if (!this.running) this.overview = loadOverview(this.root(), this.panels.env) ?? this.overview;
    this.host.showOverlay(this);
  }

  redraw() {
    if (this.host.overlay === this) this.host.showOverlay(this);
  }

  render(size) {
    const width = this.panels.inner(size);
    const view = securityLines({ overview: this.overview, running: this.running, cursor: this.cursor, open: this.openFinding, width, spaces: this.host.spaces, truecolor: this.host.truecolor, now: this.panels.now() });
    const hint = `${this.running ? '' : 'r run the checks · '}${this.overview?.findings.length ? '↵ why and fix · j k move · ' : ''}esc close`;
    return this.panels.box({ title: 'Security', hint, ...view }, size);
  }

  keys(text) {
    for (const key of panelKeys(text)) {
      if (key === 'esc') return this.host.closeOverlay();
      if (key === 'r' && !this.running) this.run();
      else if (key === 'enter') this.openFinding = !this.openFinding;
      else {
        const to = moveIn(key, this.cursor, this.overview?.findings.length ?? 0);
        if (to != null) {
          this.cursor = to;
          this.openFinding = false;
        }
      }
    }
    this.host.showOverlay(this);
  }

  /** Runs every check for the project; the panel draws the progress and the overview if it's still open, and the bar says when it's done. */
  run() {
    this.running = { done: 0, total: 0 };
    const onProgress = (done, total) => {
      this.running = { done, total };
      this.redraw();
    };
    Promise.resolve()
      .then(() => this.panels.runSecurity(this.panels.cwd, { compiled: this.panels.compiled, home: this.panels.familyDir, env: this.panels.env, onProgress }))
      .then(
        (o) => {
          this.overview = o;
          this.cursor = 0;
          this.openFinding = false;
          const bad = (o.counts.critical ?? 0) + (o.counts.high ?? 0);
          this.host.notice(bad ? `Security: ${bad} critical or high (prefix S)` : 'Security: nothing critical or high');
        },
        (e) => this.host.notice(`Security checks failed: ${String(e?.message ?? e).split('\n')[0]}`),
      )
      .finally(() => {
        this.running = null;
        this.redraw();
      });
  }
}
