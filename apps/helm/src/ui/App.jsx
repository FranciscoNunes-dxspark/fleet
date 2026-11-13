import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import * as buffer from '../buffer.js';
import { fromColumn, highlight, withCursor, withSelection } from '../highlight.js';
import { HELP } from '../help.js';
import { FACES, moodFor } from '../pet.js';
import { familyMood, reactionTo } from '../moods.js';
import { theme } from '../theme.js';
import { useKeyTranslation, useTerminalSize } from '@fleet/kit/ui/hooks.js';
import { Panel, PromptBox, Row, promptHeight } from '@fleet/kit/ui/parts.jsx';
import { StatusLine, topLine } from '@fleet/kit/ui/shell.jsx';
import { fitSegments } from '@fleet/kit/text.js';
import { screenLines } from '@fleet/kit/vt.js';
import { copyToClipboard } from '@fleet/kit/clipboard.js';
import { logActivity, readMoods, writeMood } from '@fleet/kit/family.js';

const GUTTER = 5;
const HINTS = {
  script: 'F5 run · F8 run line/selection · ctrl+s save · ctrl+f find · ctrl+z undo · ctrl+t console · F1 help',
  console: 'keys go to PowerShell · F5 run script · F8 run line · shift+pgup/pgdn look back · ctrl+t script',
};
const VIEWS = [
  { id: 'script', key: 1, label: 'Script' },
  { id: 'console', key: 2, label: 'Console' },
];
const PATH_PLACEHOLDER = {
  open: 'path of the script to open (esc cancels)',
  save: 'path to save the script to (esc cancels)',
  find: 'text to find (esc cancels)',
};
const UNDO_DEPTH = 200;
const UNDO_JOIN_MS = 500;
const WHEEL_ROWS = 3;
const NOTE_MS = 5000;

// Ink doesn't report function keys at all (F5 arrives as an empty key), so they are turned into the
// ctrl keys that do the same, before anything else sees them.
const ESC = String.fromCharCode(27);
const F5 = `${ESC}[15~`;
const F8 = `${ESC}[19~`;
const FUNCTION_KEYS = {
  [F5]: String.fromCharCode(18), // F5 → ctrl+r
  [F8]: String.fromCharCode(5), // F8 → ctrl+e
  [`${ESC}OP`]: `${ESC}h`, // F1 → alt+h
  [`${ESC}[11~`]: `${ESC}h`,
};
// In the Console view every key goes to PowerShell as it came, but these: F5 and F8 run, ctrl+t and ctrl+\ go back
// to the script, ctrl+q quits, and shift+PgUp/PgDn look back through what scrolled away.
const CONSOLE_KEYS = /(\x1b\[15~|\x1b\[19~|\x14|\x1c|\x11|\x1b\[5;2~|\x1b\[6;2~)/;

// The top line's right side: the script's file (with * while it has unsaved changes) and the PowerShell
// that runs it.
function headerContext({ path, dirty, shell, running }) {
  const segs = [];
  if (running) segs.push({ text: 'running', color: theme.warn }, { text: '  ' });
  segs.push({ text: `${path ? basename(path) : 'untitled.ps1'}${dirty ? ' *' : ''}`, color: theme.dim });
  if (shell) segs.push({ text: `  ${shell.name}`, color: theme.dim });
  return segs;
}

// The console's rows are drawn by a component of their own, which PowerShell's output renders again alone: the script,
// the panes and the lines around them stay as they were, however fast it prints. A row is memoised by its text, so a
// key's echo draws one row again rather than every row of the console.
const ConsoleLine = memo(function ConsoleLine({ line }) {
  return <Text wrap="truncate">{line}</Text>;
});
const ConsoleLines = memo(function ConsoleLines({ term, changes, height, back, cursor }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const changed = () => setTick((n) => n + 1);
    changes.add(changed);
    return () => changes.delete(changed);
  }, [changes]);
  return screenLines(term.vt, { height, back, cursor }).map((line, i) => <ConsoleLine key={i} line={line} />);
});

/** A path as a PowerShell string: single quotes, each one in it doubled (PowerShell takes the curly ones as quotes too). */
export const psQuote = (s) => `'${String(s).replace(/['‘’‚‛]/g, (q) => q + q)}'`;

// `shell` is { name, open(options) } (cli.jsx: terminal.js's openTerminal for the PowerShell found), or null when
// there is none; `file` is opened at the start. `setTitle` comes from cli.jsx; tests leave it out.
// `family: false` keeps the app out of the family's mood and activity files (the tests' way); `moodEvery` is how
// often a sibling's mood is looked for. `scratch` is the folder unsaved scripts and selections are run from.
export function App({ shell, file, cwd = process.cwd(), setTitle, mouse, family = true, moodEvery = 30_000, scratch = join(tmpdir(), `helm-${process.pid}`) }) {
  const { exit } = useApp();
  const { columns, rows: screenRows } = useTerminalSize();
  // Every row of the screen (patches/ink+6.8.0.patch draws a frame that tall again in place, rather than clearing the
  // terminal first, which flashed on each key and each line PowerShell wrote).
  const rows = Math.max(10, screenRows);
  const [buf, setBuf] = useState(() => buffer.create(''));
  const [top, setTop] = useState(0);
  const [left, setLeft] = useState(0);
  const [path, setPath] = useState(null);
  const pathFile = useRef(null);
  const [dirty, setDirtyState] = useState(false);
  const dirtyRef = useRef(false);
  const setDirty = (v) => {
    dirtyRef.current = v;
    setDirtyState(v);
  };
  // Which view is shown: 'script' (the script over the console) or 'console' (the whole screen for PowerShell, which
  // then has the keys).
  const [focus, setFocusState] = useState('script');
  // Kept in a ref too: the key after ctrl+t can arrive before React has drawn the switch.
  const focusRef = useRef('script');
  const setFocus = (v) => {
    focusRef.current = typeof v === 'function' ? v(focusRef.current) : v;
    setFocusState(focusRef.current);
  };
  // PowerShell, with its terminal (terminal.js), and how it ended when it has.
  const termRef = useRef(null);
  const [, setTick] = useState(0);
  // Who hears that PowerShell's screen changed: the console's rows (ConsoleLines), not the whole app.
  const consoleChanges = useRef(new Set()).current;
  const [ended, setEnded] = useState(null);
  const [back, setBack] = useState(0);
  const [note, setNote] = useState(null);
  const [prompt, setPrompt] = useState({ value: '', cursor: 0 });
  const [pathMode, setPathModeState] = useState(null);
  // In a ref too, like the focus: the key after a path is submitted can arrive before React has drawn it.
  const pathRef = useRef(null);
  const setPathMode = (v) => {
    pathRef.current = v;
    setPathModeState(v);
  };
  const [split, setSplit] = useState(0.55);
  const [help, setHelp] = useState(false);
  const helpRef = useRef(false);
  helpRef.current = help;
  const lastFind = useRef('');
  const undoStack = useRef([]);
  const redoStack = useRef([]);
  const lastEdit = useRef(0);
  // The newest result ({ ok, at }) for Spoke's mood, which wears off; a sibling's mood Spoke reacts to until esc.
  const [last, setLast] = useState(null);
  const [, setMoodTick] = useState(0);
  const [reaction, setReaction] = useState(null);
  const seenMoods = useRef(new Set());
  // A run F5 or F8 typed, until PowerShell's prompt comes back and says how it went: { did }.
  const [running, setRunning] = useState(false);
  const runningRef = useRef(null);
  const quitArmed = useRef(false);
  // What the keys act on, kept in step synchronously: keys can arrive faster than React renders.
  const bufRef = useRef(buf);
  const promptRef = useRef(prompt);
  const update = (fn) => {
    bufRef.current = fn(bufRef.current);
    setBuf(bufRef.current);
  };
  const setPromptNow = (value, cursor) => {
    promptRef.current = { value, cursor };
    setPrompt(promptRef.current);
  };
  const say = (text, tone) => setNote({ text, tone, at: Date.now() });

  // Layout: the top line, the script pane and the console pane (or the console alone), the prompt while a path or a
  // find is asked (its rows taken from the script), the status line. A pane's title row is the only row it spends.
  const body = Math.max(8, rows - 2);
  const scriptH = Math.max(4, Math.min(body - 4, Math.floor(body * split)));
  const consoleH = focus === 'console' ? body : Math.max(4, body - scriptH);
  const inner = columns - 2;
  const asking = pathMode ? promptHeight() : 0;
  const scriptRows = Math.max(1, scriptH - 1 - asking);
  const consoleRows = consoleH - 1;
  const codeW = Math.max(10, inner - GUTTER);
  const size = useRef({ columns: inner, rows: consoleRows });
  size.current = { columns: Math.max(20, inner), rows: Math.max(3, consoleRows) };

  // Edits close together share one undo step, so typing a word undoes as a word.
  const edit = (fn) => {
    const now = Date.now();
    if (!undoStack.current.length || now - lastEdit.current > UNDO_JOIN_MS) undoStack.current = [...undoStack.current, bufRef.current].slice(-UNDO_DEPTH);
    lastEdit.current = now;
    redoStack.current = [];
    update(fn);
    setDirty(true);
  };
  const travel = (from, to) => {
    if (!from.current.length) return;
    to.current = [...to.current, bufRef.current];
    const next = from.current.at(-1);
    from.current = from.current.slice(0, -1);
    lastEdit.current = 0;
    update(() => next);
    setDirty(true);
  };
  const resetHistory = () => {
    undoStack.current = [];
    redoStack.current = [];
  };
  const copySelection = (cut) => {
    const text = buffer.selectedText(bufRef.current);
    if (!text) return false;
    copyToClipboard(text).then((where) => say(`${cut ? 'Cut' : 'Copied'} ${text.length} characters${where === 'terminal' ? ' (through the terminal)' : ''}`));
    if (cut) edit(buffer.removeSelection);
    return true;
  };
  const findNext = (query) => {
    const hit = buffer.find(bufRef.current, query);
    if (!hit) return say(`Not found: ${query}`);
    update(() => hit);
  };
  const moveCursor = (to) => update((b) => buffer.move(b, to, scriptRows - 1));

  // The prompt came back: the run F5 or F8 typed is over, and how it went is Spoke's and the activity log's.
  const finishRun = (ok) => {
    const run = runningRef.current;
    if (!run) return;
    runningRef.current = null;
    setRunning(false);
    setLast({ ok, at: Date.now() });
    if (family) logActivity('helm', { text: ok ? run.did : `${run.did} (it failed)`, kind: ok ? 'info' : 'error', project: cwd });
  };

  // PowerShell, as big as the console pane is; started again by ↵ in the Console view, or by a run, once it ended.
  const openShell = () => {
    if (termRef.current?.alive) return termRef.current;
    if (!shell) return null;
    termRef.current?.close();
    setEnded(null);
    const mine = shell.open({
      ...size.current,
      cwd,
      onChange: () => {
        if (termRef.current === mine) for (const changed of consoleChanges) changed();
      },
      onPrompt: (ok) => termRef.current === mine && finishRun(ok),
      onExit: (info) => {
        if (termRef.current !== mine) return;
        setEnded(info);
        if (runningRef.current) finishRun(false);
      },
    });
    termRef.current = mine;
    setTick((n) => n + 1);
    return mine;
  };

  // Keep the cursor in view as it moves.
  useEffect(() => {
    setTop((t) => buffer.scrollFor(buf.row, t, scriptRows));
    setLeft((l) => (buf.col < l ? buf.col : buf.col >= l + codeW - 1 ? buf.col - codeW + 2 : l));
  }, [buf.row, buf.col, scriptRows, codeW]);

  useEffect(() => {
    setTitle?.(`Helm${path ? ` — ${basename(path)}` : ''}${dirty ? ' *' : ''}`);
  }, [path, dirty]);

  useEffect(() => {
    if (file) openFile(file);
    openShell();
    return () => {
      termRef.current?.close();
      rmSync(scratch, { recursive: true, force: true });
    };
  }, []);

  // The console's room changes with the view and the split: PowerShell is told (terminal.js waits for it to settle).
  useEffect(() => {
    if (termRef.current?.alive) termRef.current.resize(size.current.columns, size.current.rows);
  }, [size.current.columns, size.current.rows]);

  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote((n) => (n === note ? null : n)), NOTE_MS);
    return () => clearTimeout(t);
  }, [note]);

  useEffect(() => {
    if (!last) return;
    const t = setTimeout(() => setMoodTick((n) => n + 1), 8100);
    return () => clearTimeout(t);
  }, [last]);

  useEffect(() => {
    if (!family || !moodEvery) return setReaction(null);
    const look = () => {
      const r = reactionTo(readMoods('helm'), seenMoods.current);
      if (!r) return;
      seenMoods.current.add(r.key);
      setReaction(r);
    };
    look();
    const t = setInterval(look, moodEvery);
    return () => clearInterval(t);
  }, [family, moodEvery]);

  // Types `line` into PowerShell and presses ↵, as if you had. `did` is what the family's activity log says about it:
  // which script, never the code. With no prompt marks (terminal.js), a run's end can't be told, so none is waited for.
  const typeRun = (line, did) => {
    const t = openShell();
    if (!t) return say('No PowerShell found: install pwsh (PowerShell 7).', 'danger');
    setBack(0);
    if (t.marks) {
      runningRef.current = { did };
      setRunning(true);
    } else if (family) logActivity('helm', { text: did, kind: 'info', project: cwd });
    t.write(`${line}\r`);
  };
  // Code of more than one line goes in a file in the scratch folder, dot-sourced, so it runs as one.
  const scratchFile = (name, text) => {
    mkdirSync(scratch, { recursive: true });
    const full = join(scratch, name);
    writeFileSync(full, text);
    return full;
  };
  const runScript = () => {
    const text = buffer.textOf(bufRef.current);
    if (!text.trim()) return;
    const name = path ? basename(path) : 'untitled.ps1';
    // A saved script runs from where it is (its $PSScriptRoot is its folder); one with changes, as it is on screen.
    const where = pathFile.current && !dirtyRef.current ? pathFile.current : scratchFile(name, text);
    typeRun(`. ${psQuote(where)}`, `Ran ${path ? name : 'a script'}`);
  };
  const runLine = () => {
    const picked = buffer.selectedText(bufRef.current);
    const code = picked || buffer.currentLine(bufRef.current);
    if (!code.trim()) return;
    if (code.includes('\n')) return typeRun(`. ${psQuote(scratchFile('selection.ps1', code))}`, 'Ran a selection');
    // A tab would ask PowerShell to complete what's typed.
    typeRun(code.replace(/\t/g, '  ').trim(), picked ? 'Ran a selection' : 'Ran a line');
  };
  // esc and ctrl+c, from the script: ctrl+c to PowerShell, which stops what it's running (sent at an idle prompt only
  // when there are no prompt marks to tell whether something runs).
  const stop = () => {
    const t = termRef.current;
    if (t?.alive && (runningRef.current || !t.marks)) t.write('\x03');
  };
  const quit = () => {
    if (dirtyRef.current && !quitArmed.current) {
      quitArmed.current = true;
      return say('The script has unsaved changes: ctrl+s saves, ctrl+q again quits without saving.', 'warn');
    }
    exit();
  };
  const scroll = (n) => {
    const t = termRef.current;
    const most = t ? t.vt.history.length : 0;
    setBack((b) => Math.max(0, Math.min(most, b + n)));
  };

  function openFile(name) {
    try {
      const full = resolve(cwd, name);
      update(() => buffer.create(readFileSync(full, 'utf8')));
      resetHistory();
      setPath(full);
      pathFile.current = full;
      setDirty(false);
      setTop(0);
      say(`Opened ${full}`);
    } catch (err) {
      say(`Could not open ${name}: ${err.message}`, 'danger');
    }
  }

  function saveFile(name) {
    try {
      const full = resolve(cwd, name);
      writeFileSync(full, buffer.textOf(bufRef.current));
      setPath(full);
      pathFile.current = full;
      setDirty(false);
      say(`Saved ${full}`);
    } catch (err) {
      say(`Could not save ${name}: ${err.message}`, 'danger');
    }
  }

  const ask = (mode) => {
    setPathMode(mode);
    const value = mode === 'save' && path ? path : mode === 'find' ? lastFind.current : '';
    setPromptNow(value, value.length);
  };

  const submit = () => {
    const value = promptRef.current.value;
    const mode = pathRef.current;
    setPromptNow('', 0);
    setPathMode(null);
    if (mode === 'find') {
      lastFind.current = value;
      return findNext(value);
    }
    if (value.trim()) (mode === 'open' ? openFile : saveFile)(value.trim());
  };

  // Line editing in the path and find prompt.
  const promptKeys = (input, key) => {
    const { value, cursor } = promptRef.current;
    const set = setPromptNow;
    if (key.return) return submit();
    if (key.leftArrow) return set(value, Math.max(0, cursor - 1));
    if (key.rightArrow) return set(value, Math.min(value.length, cursor + 1));
    if (key.home) return set(value, 0);
    if (key.end) return set(value, value.length);
    if (key.backspace || key.delete) return cursor > 0 ? set(value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1) : undefined;
    if (key.ctrl && input === 'u') return set(value.slice(cursor), 0);
    if (key.ctrl || key.meta || !input) return;
    const text = input.replace(/\r?\n/g, ' ');
    set(value.slice(0, cursor) + text + value.slice(cursor), cursor + text.length);
  };

  const scriptKeys = (input, key) => {
    if (key.shift) {
      const to = key.leftArrow ? 'left' : key.rightArrow ? 'right' : key.upArrow ? 'up' : key.downArrow ? 'down' : key.home ? 'home' : key.end ? 'end' : key.pageUp ? 'pageUp' : key.pageDown ? 'pageDown' : null;
      if (to) return update((b) => buffer.extend(b, to, scriptRows - 1));
    }
    if (key.return) return edit(buffer.newline);
    if (key.leftArrow) return moveCursor('left');
    if (key.rightArrow) return moveCursor('right');
    if (key.upArrow) return moveCursor('up');
    if (key.downArrow) return moveCursor('down');
    if (key.pageUp) return moveCursor('pageUp');
    if (key.pageDown) return moveCursor('pageDown');
    if (key.home) return moveCursor('home');
    if (key.end) return moveCursor('end');
    if (key.backspace || key.delete) return edit(buffer.backspace);
    if (key.ctrl && input === 'd') return edit(buffer.del);
    if (key.tab && !key.shift) return edit((b) => buffer.insert(b, '\t'));
    if (key.ctrl || key.meta || !input) return;
    edit((b) => buffer.insert(b, input));
  };

  // The Console view's keys, before Ink reads any: PowerShell's, as they came, but for CONSOLE_KEYS. A shell that
  // ended waits for ↵ to start another.
  const consoleKeys = (input) => {
    for (const part of input.split(CONSOLE_KEYS)) {
      if (!part) continue;
      if (part === F5) queueMicrotask(runScript);
      else if (part === F8) queueMicrotask(runLine);
      else if (part === '\x14' || part === '\x1c') setFocus('script');
      else if (part === '\x11') quit();
      else if (part === '\x1b[5;2~') scroll(Math.max(1, size.current.rows - 1));
      else if (part === '\x1b[6;2~') scroll(-Math.max(1, size.current.rows - 1));
      else if (focusRef.current !== 'console') continue;
      else if (termRef.current?.alive) {
        quitArmed.current = false;
        setBack(0);
        termRef.current.write(part);
      } else if (part.includes('\r')) openShell();
    }
    return null;
  };

  useKeyTranslation((input) => {
    if (focusRef.current === 'console' && !pathRef.current && !helpRef.current) return consoleKeys(input);
    return FUNCTION_KEYS[input] ?? input;
  });

  useInput((input, key) => {
    if (help && !(key.ctrl && input === 'q')) return setHelp(false);
    if (key.escape && reaction && !runningRef.current && !pathRef.current) return setReaction(null);
    if (key.ctrl && input === 'q') return quit();
    quitArmed.current = false;
    if (pathRef.current) {
      if (key.escape || (key.ctrl && input === 'c')) {
        setPathMode(null);
        return setPromptNow('', 0);
      }
      return promptKeys(input, key);
    }
    if (key.ctrl && input === 'c' && !runningRef.current && copySelection(false)) return;
    if (key.escape && buffer.selection(bufRef.current) && !runningRef.current) return update((b) => ({ ...b, anchor: undefined }));
    if ((key.ctrl && input === 'c') || key.escape) return stop();
    if (key.meta && input === 'h') return setHelp(true);
    if (key.meta && (input === '1' || input === '2')) return setFocus(input === '1' ? 'script' : 'console');
    if (key.meta && (key.upArrow || key.downArrow)) return setSplit((v) => Math.max(0.25, Math.min(0.8, v + (key.downArrow ? 0.05 : -0.05))));
    if (key.ctrl && input === 'z') return travel(undoStack, redoStack);
    if (key.ctrl && input === 'y') return travel(redoStack, undoStack);
    if (key.ctrl && input === 'a') return update(buffer.selectAll);
    if (key.ctrl && input === 'x') return void copySelection(true);
    if (key.ctrl && input === 'f') return ask('find');
    if (key.ctrl && input === 'g') return lastFind.current ? findNext(lastFind.current) : ask('find');
    if (key.ctrl && input === 'r') return runScript();
    if (key.ctrl && input === 'e') return runLine();
    if (key.ctrl && input === 's') return path ? saveFile(path) : ask('save');
    if (key.ctrl && input === 'o') return ask('open');
    if (key.ctrl && input === 'n') {
      resetHistory();
      update(() => buffer.create(''));
      setPath(null);
      pathFile.current = null;
      setDirty(false);
      return setTop(0);
    }
    // ctrl+l clears the console: PowerShell's own clear screen, and what scrolled away.
    if (key.ctrl && input === 'l') {
      if (runningRef.current || !termRef.current?.alive) return;
      termRef.current.vt.history.length = 0;
      setBack(0);
      return termRef.current.write('\x0c');
    }
    if ((key.ctrl && input === 't') || (key.tab && key.shift)) return setFocus('console');
    return scriptKeys(input, key);
  });

  // The mouse (where the terminal reports it): a click on a view's tab switches to it, a click or a
  // drag in the script places the cursor or selects, the wheel scrolls what is under it. The layout is
  // the one drawn below: the top line, then each pane's title row, then its rows.
  const geo = useRef(null);
  const cellAt = (x, y) => {
    const g = geo.current;
    const b = bufRef.current;
    const row = Math.max(0, Math.min(b.lines.length - 1, g.top + y - 2));
    return { row, col: Math.max(0, Math.min(b.lines[row].length, g.left + x - 2 - GUTTER)) };
  };
  const inScript = (x, y) => geo.current && geo.current.view === 'script' && y >= 2 && y < 2 + geo.current.scriptRows && x >= 2 + GUTTER;
  const onMouse = (e) => {
    const g = geo.current;
    if (!g || help) return;
    if (e.drag && e.from) {
      if (!inScript(e.from.x, e.from.y)) return;
      const from = cellAt(e.from.x, e.from.y);
      const to = cellAt(e.x, e.y);
      return update((b) => ({ ...b, row: to.row, col: to.col, anchor: from }));
    }
    if (e.wheel) {
      if (g.view === 'script' && e.y >= 1 && e.y < 1 + g.scriptH) return setTop((t) => Math.max(0, Math.min(bufRef.current.lines.length - 1, t + e.wheel * WHEEL_ROWS)));
      return scroll(-e.wheel * WHEEL_ROWS);
    }
    if (e.button !== 'left' || e.release) return;
    if (e.y === 0) {
      const tab = g.tabs.find((t) => e.x >= t.x && e.x < t.x + t.width);
      if (tab && !pathRef.current) setFocus(tab.id);
      return;
    }
    if (inScript(e.x, e.y) && !pathRef.current) {
      const at = cellAt(e.x, e.y);
      update((b) => ({ ...b, row: at.row, col: at.col, anchor: undefined }));
    }
  };
  const mouseRef = useRef(onMouse);
  mouseRef.current = onMouse;
  useEffect(() => mouse?.subscribe((e) => mouseRef.current(e)), [mouse]);
  useEffect(() => mouse?.claimDrags((press) => !!geo.current && inScript(press.x, press.y)), [mouse]);
  useEffect(() => {
    mouse?.enable(true);
  }, [mouse]);

  // The script's rows, highlighted again only when what they show changed (not for each chunk PowerShell prints).
  const scriptCursor = focus === 'script' && !pathMode;
  const scriptLines = useMemo(() => {
    // The bracket at the cursor and its partner are marked.
    const partner = scriptCursor && !buf.anchor ? buffer.matchBracket(buf) : null;
    const pairMarks = partner ? [partner, ...[buf.col, buf.col - 1].filter((c) => '()[]{}'.includes(buf.lines[buf.row][c] ?? ' ')).slice(0, 1).map((col) => ({ row: buf.row, col }))] : [];
    const lines = [];
    for (let i = top; i < Math.min(buf.lines.length, top + scriptRows); i++) {
      let segs = highlight(buf.lines[i]);
      const sel = buffer.selectedColumns(buf, i);
      if (sel) segs = withSelection(segs, sel[0], sel[1]);
      for (const m of pairMarks) if (m.row === i) segs = withSelection(segs, m.col, m.col + 1, { bold: true, color: theme.accent, underline: true });
      if (i === buf.row && scriptCursor && !buf.anchor) segs = withCursor(segs, buf.col);
      lines.push(
        <Row key={i} pointer={false} width={inner} segments={[{ text: String(i + 1).padStart(GUTTER - 1) + ' ', color: i === buf.row ? theme.accent : theme.dim }, ...fitSegments(fromColumn(segs, left), codeW)]} />,
      );
    }
    return lines;
  }, [buf, top, left, scriptRows, scriptCursor, inner, codeW]);

  // The console: PowerShell's scrollback and screen, its cursor showing while it has the keys.
  const term = termRef.current;
  const typing = focus === 'console' && !pathMode && !help;
  const consoleEls = term
    ? <ConsoleLines term={term} changes={consoleChanges} height={consoleRows} back={back} cursor={typing && term.alive} />
    : [<Row key="none" pointer={false} width={inner} segments={[{ text: '  No PowerShell found: install pwsh (PowerShell 7) to run scripts.', color: theme.dim }]} />];
  const consoleHint = back ? `${back} lines up` : ended ? `ended${ended.code ? ` (exit ${ended.code})` : ''}${ended.error ? `: ${ended.error.message}` : ''} · ↵ in the Console starts it again` : undefined;

  const mood = moodFor({ state: { running, none: !shell }, last });
  const feeling = familyMood({ mood });
  useEffect(() => {
    if (family) writeMood('helm', feeling);
  }, [feeling.mood, feeling.reason, family]);
  const top1 = topLine({ face: FACES[mood], title: 'Helm', views: VIEWS, view: focus, context: headerContext({ path, dirty, shell, running }), width: columns, compact: true });

  geo.current = { top, left, view: focus, scriptRows, scriptH, tabs: top1.tabs };
  let main;
  if (help) {
    const lines = [];
    for (const section of HELP) {
      lines.push(<Row key={`h${section.title}`} pointer={false} width={inner} segments={[{ text: section.title, color: theme.accent, bold: true }]} />);
      for (const [keys, what] of section.rows) lines.push(<Row key={`${section.title}${keys}`} pointer={false} width={inner} segments={[{ text: `  ${keys.padEnd(18)}`, color: theme.accent }, { text: what }]} />);
    }
    main = (
      <Panel title="Keyboard shortcuts" hint="any key closes" width={columns} height={body} focused>
        {lines.slice(0, body - 1)}
      </Panel>
    );
  } else if (focus === 'console') {
    main = (
      <Panel title="Console" hint={consoleHint} width={columns} height={consoleH} focused>
        {consoleEls}
      </Panel>
    );
  } else {
    main = (
      <>
        <Panel title="Script" hint={`${buf.row + 1}:${buf.col + 1}${buffer.selection(buf) ? ` · ${buffer.selectedText(buf).length} selected` : ''}`} width={columns} height={scriptH - asking} focused={!pathMode}>
          {scriptLines}
        </Panel>
        {pathMode ? <PromptBox value={prompt.value} cursor={prompt.cursor} focused width={columns} placeholder={PATH_PLACEHOLDER[pathMode]} bang={false} /> : null}
        <Panel title="Console" hint={consoleHint ?? 'ctrl+t types in it'} width={columns} height={consoleH} focused={false}>
          {consoleEls}
        </Panel>
      </>
    );
  }

  const message = pathMode ? PATH_PLACEHOLDER[pathMode] : note ? note.text : running ? 'running… (esc stops)' : reaction ? [{ text: reaction.text }, { text: '  esc', color: theme.dim }] : '';
  const tone = pathMode ? undefined : note ? note.tone : running ? 'warn' : undefined;
  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Row pointer={false} width={columns} segments={top1.segments} />
      {main}
      <StatusLine face={FACES[reaction && !running ? (reaction.mood === 'happy' ? 'happy' : 'worried') : mood]} news={Boolean(reaction) && !running && !pathMode && !note} message={message} tone={tone} keys={pathMode ? '↵ go · esc cancel' : HINTS[focus]} width={columns} />
    </Box>
  );
}
