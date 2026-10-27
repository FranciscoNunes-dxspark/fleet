// The host's panels over the apps: the runbooks (ctrl+] r: a picker, then a runbook whose steps are
// handed to their apps one ↵ at a time). A panel is an object with `render(size)` (the box, as ANSI
// text placed on screen) and `keys(text)`; the host shows one at a time (Host.showOverlay) and gives
// it every key while it's open. What it does to the apps goes back through the host: `sendLine` (a
// hand-off).
import { join, relative } from 'node:path';
import { familyDir as kitFamilyDir, readActivity } from '@fleet/kit/family.js';
import { keyLength } from './keys.js';
import { boxRows, boxSize, pickerLines, placeBox, runbookLines } from './overlay.js';
import { draftRunbook, listRunbooks, runbookDirs, writeDraft } from './runbooks.js';

const HOUR = 60 * 60_000;

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
  constructor(host, { cwd = process.cwd(), env = process.env, familyDir = kitFamilyDir(env), now = () => Date.now() } = {}) {
    Object.assign(this, { host, cwd, env, familyDir, now });
    this.runbookPanel = new RunbookPanel(this);
  }

  /** ctrl+] r: the runbook you were in, else the picker. */
  runbooks() {
    this.runbookPanel.open();
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
