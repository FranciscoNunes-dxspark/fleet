import React, { useEffect, useRef, useState } from 'react';
import { Box, useApp, useInput } from 'ink';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import * as buffer from '../buffer.js';
import { fromColumn, highlight, withCursor, withSelection } from '../highlight.js';
import { ERROR_MARK, VERBOSE_MARK, WARN_MARK } from '../powershell.js';
import { HELP } from '../help.js';
import { FACES, moodFor } from '../pet.js';
import { familyMood, reactionTo } from '../moods.js';
import { theme } from '../theme.js';
import { VERSION } from '../app.js';
import { useKeyTranslation, useTerminalSize } from '@fleet/kit/ui/hooks.js';
import { Panel, PromptBox, Row, promptHeight } from '@fleet/kit/ui/parts.jsx';
import { StatusLine, topLine } from '@fleet/kit/ui/shell.jsx';
import { fitSegments } from '@fleet/kit/text.js';
import { copyToClipboard } from '@fleet/kit/clipboard.js';
import { logActivity, readMoods, writeMood } from '@fleet/kit/family.js';

const GUTTER = 5;
const MAX_OUTPUT = 5000;
const HINTS = {
  script: 'F5 run · F8 run line/selection · ctrl+s save · ctrl+f find · ctrl+z undo · ctrl+t console · F1 help',
  console: '↵ run · tab complete · ↑↓ history · pgup/pgdn scroll · ctrl+l clear · ctrl+t script · F1 help',
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

// Ink doesn't report function keys at all (F5 arrives as an empty key), so they are turned into the
// ctrl keys that do the same, before anything else sees them.
const ESC = String.fromCharCode(27);
const FUNCTION_KEYS = {
  [`${ESC}[15~`]: String.fromCharCode(18), // F5 → ctrl+r
  [`${ESC}[19~`]: String.fromCharCode(5), // F8 → ctrl+e
  [`${ESC}OP`]: `${ESC}h`, // F1 → alt+h
  [`${ESC}[11~`]: `${ESC}h`,
};

// The top line's right side: the script's file (with * while it has unsaved changes) and the PowerShell
// that runs it.
function headerContext({ path, dirty, session, running }) {
  const segs = [];
  if (running) segs.push({ text: 'running', color: theme.warn }, { text: '  ' });
  segs.push({ text: `${path ? basename(path) : 'untitled.ps1'}${dirty ? ' *' : ''}`, color: theme.dim });
  if (session) segs.push({ text: `  ${session.bin}`, color: theme.dim });
  return segs;
}

const OUTPUT_COLOR = { in: () => theme.accent, err: () => theme.del, warn: () => theme.warn, verbose: () => theme.dim, info: () => theme.dim, out: () => undefined };

// The last `rows` screen rows of lines[..end): long lines wrap, and only the ones that show are cut up.
function tailRows(lines, end, rows, width) {
  const out = [];
  for (let i = end - 1; i >= 0 && out.length < rows; i--) {
    const text = lines[i].text.replace(/\t/g, '    ');
    const parts = [];
    for (let at = 0; at < Math.max(1, text.length); at += width) parts.push(text.slice(at, at + width));
    for (let k = parts.length - 1; k >= 0 && out.length < rows; k--) out.push({ kind: lines[i].kind, text: parts[k] });
  }
  return out.reverse();
}

// `session` is powershell.js's createSession (or null when no PowerShell is installed); `file` is
// opened at the start. `setTitle` comes from cli.jsx; tests leave it out.
// `family: false` keeps the app out of the family's mood and activity files (the tests' way); `moodEvery` is how
// often a sibling's mood is looked for.
export function App({ session, file, cwd = process.cwd(), setTitle, mouse, family = true, moodEvery = 30_000 }) {
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize();
  const [buf, setBuf] = useState(() => buffer.create(''));
  const [top, setTop] = useState(0);
  const [left, setLeft] = useState(0);
  const [path, setPath] = useState(null);
  const [dirty, setDirtyState] = useState(false);
  const dirtyRef = useRef(false);
  const setDirty = (v) => {
    dirtyRef.current = v;
    setDirtyState(v);
  };
  // Which view is shown: 'script' (the script over its output) or 'console' (the whole screen for the session).
  const [focus, setFocusState] = useState('script');
  // Kept in a ref too: the key after ctrl+t can arrive before React has drawn the switch.
  const focusRef = useRef('script');
  const setFocus = (v) => {
    focusRef.current = typeof v === 'function' ? v(focusRef.current) : v;
    setFocusState(focusRef.current);
  };
  const [output, setOutput] = useState(() => [{ kind: 'info', text: session ? `Helm ${VERSION} — PowerShell session in ${cwd}` : 'No PowerShell found: install pwsh (PowerShell 7) to run scripts.' }]);
  const [back, setBack] = useState(0);
  const [prompt, setPrompt] = useState({ value: '', cursor: 0 });
  const [history, setHistory] = useState([]);
  const [recall, setRecall] = useState(-1);
  const [pathMode, setPathModeState] = useState(null);
  // In a ref too, like the focus: the key after a path is submitted can arrive before React has drawn it.
  const pathRef = useRef(null);
  const setPathMode = (v) => {
    pathRef.current = v;
    setPathModeState(v);
  };
  const [split, setSplit] = useState(0.55);
  const [help, setHelp] = useState(false);
  const returnTo = useRef('script');
  const lastFind = useRef('');
  const undoStack = useRef([]);
  const redoStack = useRef([]);
  const lastEdit = useRef(0);
  const completion = useRef(null);
  // The newest result ({ ok, at }) for Spoke's mood, which wears off; a sibling's mood Spoke reacts to until esc.
  const [last, setLast] = useState(null);
  const [, setMoodTick] = useState(0);
  const [reaction, setReaction] = useState(null);
  const seenMoods = useRef(new Set());
  const [running, setRunning] = useState(false);
  const quitArmed = useRef(false);
  const runningRef = useRef(false);
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

  // Lines wait for the end of the current turn and go in together: a script printing tens of thousands
  // of lines would otherwise copy the whole pane for each one.
  const saying = useRef([]);
  const say = (kind, text) => {
    if (!saying.current.length)
      queueMicrotask(() => {
        const lines = saying.current;
        saying.current = [];
        setOutput((o) => (o.length + lines.length > MAX_OUTPUT ? [...o, ...lines].slice(-MAX_OUTPUT) : [...o, ...lines]));
      });
    saying.current.push({ kind, text });
  };
  const clearOutput = () => {
    saying.current.length = 0;
    setOutput([]);
  };

  // Layout: the top line, the script pane, the output pane, the prompt, the status line. A pane's
  // title row is the only row it spends.
  const showPrompt = focus === 'console' || pathMode;
  const body = Math.max(8, rows - 2 - (showPrompt ? promptHeight() : 0));
  const scriptH = Math.max(4, Math.min(body - 4, Math.floor(body * split)));
  const outputH = Math.max(4, body - scriptH);
  // The rows that scroll the output: the output pane's, or the console's whole screen.
  const viewRows = (focus === 'console' ? body : outputH) - 1;
  const inner = columns - 2;
  const scriptRows = scriptH - 1;
  const outputRows = outputH - 1;
  const codeW = Math.max(10, inner - GUTTER);

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
    copyToClipboard(text).then((where) => say('info', `${cut ? 'Cut' : 'Copied'} ${text.length} characters${where === 'terminal' ? ' (through the terminal)' : ''}`));
    if (cut) edit(buffer.removeSelection);
    return true;
  };
  const findNext = (query) => {
    const hit = buffer.find(bufRef.current, query);
    if (!hit) return say('info', `Not found: ${query}`);
    update(() => hit);
  };
  const moveCursor = (to) => update((b) => buffer.move(b, to, scriptRows - 1));

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
    return () => session?.close();
  }, []);

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

  useKeyTranslation((input) => FUNCTION_KEYS[input] ?? input);

  // `did` is what the family's activity log says about it: which script, never the code.
  const execute = async (code, label, did = 'Ran a command') => {
    if (runningRef.current || !code.trim()) return;
    if (!session) return say('err', 'No PowerShell found.');
    runningRef.current = true;
    setRunning(true);
    setBack(0);
    say('in', label);
    let failed = false;
    try {
      const r = await session.run(code, (text) => {
        if (text.startsWith(ERROR_MARK)) {
          failed = true;
          say('err', text.slice(1));
        }
        else if (text.startsWith(WARN_MARK)) say('warn', `WARNING: ${text.slice(1)}`);
        else if (text.startsWith(VERBOSE_MARK)) say('verbose', text.slice(1));
        else say('out', text);
      });
      if (r.stopped) failed = true;
      if (r.stopped) say('info', 'Stopped. The session starts again with the next run, without its variables.');
    } catch (err) {
      failed = true;
      say('err', String(err.message ?? err));
    }
    runningRef.current = false;
    setRunning(false);
    setLast({ ok: !failed, at: Date.now() });
    if (family) logActivity('helm', { text: failed ? `${did} (it failed)` : did, kind: failed ? 'error' : 'info', project: cwd });
  };

  const runScript = () => execute(buffer.textOf(bufRef.current), `▶ Run ${path ? basename(path) : 'script'}`, `Ran ${path ? basename(path) : 'a script'}`);
  const runLine = () => {
    const picked = buffer.selectedText(bufRef.current);
    if (picked) return execute(picked, `▶ selection (${picked.split('\n').length} line${picked.includes('\n') ? 's' : ''})`, 'Ran a selection');
    const line = buffer.currentLine(bufRef.current);
    return execute(line, `▶ ${line.trim()}`, 'Ran a line');
  };

  function openFile(name) {
    try {
      const full = resolve(cwd, name);
      update(() => buffer.create(readFileSync(full, 'utf8')));
      resetHistory();
      setPath(full);
      setDirty(false);
      setTop(0);
      say('info', `Opened ${full}`);
    } catch (err) {
      say('err', `Could not open ${name}: ${err.message}`);
    }
  }

  function saveFile(name) {
    try {
      const full = resolve(cwd, name);
      writeFileSync(full, buffer.textOf(buf));
      setPath(full);
      setDirty(false);
      say('info', `Saved ${full}`);
    } catch (err) {
      say('err', `Could not save ${name}: ${err.message}`);
    }
  }

  const ask = (mode) => {
    returnTo.current = focusRef.current;
    setPathMode(mode);
    setFocus('console');
    const value = mode === 'save' && path ? path : mode === 'find' ? lastFind.current : '';
    setPromptNow(value, value.length);
  };

  const submit = () => {
    const value = promptRef.current.value;
    setPromptNow('', 0);
    if (pathRef.current) {
      const mode = pathRef.current;
      setPathMode(null);
      setFocus(returnTo.current);
      if (mode === 'find') {
        lastFind.current = value;
        return findNext(value);
      }
      if (value.trim()) (mode === 'open' ? openFile : saveFile)(value.trim());
      return;
    }
    if (!value.trim()) return;
    setHistory((h) => [value, ...h.filter((x) => x !== value)].slice(0, 200));
    setRecall(-1);
    execute(value, `PS> ${value}`);
  };

  // Tab: what PowerShell would complete the text before the cursor to (TabExpansion2, in the session
  // itself, so its variables and modules count); pressing it again goes to the next one.
  const complete = async () => {
    const { value, cursor } = promptRef.current;
    let c = completion.current;
    if (!c || c.shown !== value) {
      if (!session?.run || runningRef.current) return;
      runningRef.current = true;
      const matches = [];
      const text = value.slice(0, cursor).replace(/'/g, "''");
      const code = `& { param($t, $c) $r = TabExpansion2 $t $c; $r.CompletionMatches | ForEach-Object { "$($r.ReplacementIndex)|$($r.ReplacementLength)|$($_.CompletionText)" } } '${text}' ${cursor}`;
      try {
        await session.run(code, (line) => {
          const m = /^(\d+)\|(\d+)\|(.*)$/.exec(line);
          if (m) matches.push({ at: Number(m[1]), len: Number(m[2]), text: m[3] });
        });
      } catch {}
      runningRef.current = false;
      if (!matches.length || promptRef.current.value !== value) return;
      c = completion.current = { orig: value, cursor, matches, i: -1, shown: value };
    }
    c.i = (c.i + 1) % c.matches.length;
    const m = c.matches[c.i];
    const next = c.orig.slice(0, m.at) + m.text + c.orig.slice(m.at + m.len);
    c.shown = next;
    setPromptNow(next, m.at + m.text.length);
  };

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
    if (!pathRef.current && (key.upArrow || key.downArrow)) {
      const next = Math.max(-1, Math.min(history.length - 1, recall + (key.upArrow ? 1 : -1)));
      setRecall(next);
      const v = next < 0 ? '' : history[next];
      return set(v, v.length);
    }
    if (key.tab && !pathRef.current) return complete();
    completion.current = null;
    if (key.pageUp) return setBack((b) => Math.min(Math.max(0, output.length - viewRows), b + viewRows - 1));
    if (key.pageDown) return setBack((b) => Math.max(0, b - viewRows + 1));
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

  useInput((input, key) => {
    if (help && !(key.ctrl && input === 'q')) return setHelp(false);
    if (key.escape && reaction && !runningRef.current && !pathRef.current) return setReaction(null);
    if (key.ctrl && input === 'q') {
      if (dirtyRef.current && !quitArmed.current) {
        quitArmed.current = true;
        return say('info', 'The script has unsaved changes: ctrl+s saves, ctrl+q again quits without saving.');
      }
      return exit();
    }
    quitArmed.current = false;
    if (key.ctrl && input === 'c' && !running && focusRef.current === 'script' && !pathRef.current && copySelection(false)) return;
    if ((key.ctrl && input === 'c') || key.escape) {
      if (running) return session.stop();
      if (key.escape && pathRef.current) {
        setPathMode(null);
        setPromptNow('', 0);
        return setFocus(returnTo.current);
      }
      if (key.escape && focusRef.current === 'script') return update((b) => ({ ...b, anchor: undefined }));
      return;
    }
    if (key.meta && input === 'h') return setHelp(true);
    if (key.meta && (input === '1' || input === '2') && !pathRef.current) return setFocus(input === '1' ? 'script' : 'console');
    if (focusRef.current === 'script' && !pathRef.current) {
      if (key.meta && (key.upArrow || key.downArrow)) return setSplit((v) => Math.max(0.25, Math.min(0.8, v + (key.downArrow ? 0.05 : -0.05))));
      if (key.ctrl && input === 'z') return travel(undoStack, redoStack);
      if (key.ctrl && input === 'y') return travel(redoStack, undoStack);
      if (key.ctrl && input === 'a') return update(buffer.selectAll);
      if (key.ctrl && input === 'x') return void copySelection(true);
      if (key.ctrl && input === 'f') return ask('find');
      if (key.ctrl && input === 'g') return lastFind.current ? findNext(lastFind.current) : ask('find');
    }
    if (key.ctrl && input === 'r') return runScript();
    if (key.ctrl && input === 'e') return runLine();
    if (key.ctrl && input === 's') return path ? saveFile(path) : ask('save');
    if (key.ctrl && input === 'o') return ask('open');
    if (key.ctrl && input === 'n') {
      resetHistory();
      update(() => buffer.create(''));
      setPath(null);
      setDirty(false);
      return setTop(0);
    }
    if (key.ctrl && input === 'l') return clearOutput();
    if ((key.ctrl && input === 't') || (key.tab && key.shift)) return pathRef.current ? undefined : setFocus((f) => (f === 'script' ? 'console' : 'script'));
    return focusRef.current === 'script' && !pathRef.current ? scriptKeys(input, key) : promptKeys(input, key);
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
      return setBack((v) => Math.max(0, Math.min(Math.max(0, output.length - g.viewRows), v - e.wheel * WHEEL_ROWS)));
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

  // The bracket at the cursor and its partner are marked.
  const partner = focus === 'script' && !pathMode && !buf.anchor ? buffer.matchBracket(buf) : null;
  const pairMarks = partner ? [partner, ...[buf.col, buf.col - 1].filter((c) => '()[]{}'.includes(buf.lines[buf.row][c] ?? ' ')).slice(0, 1).map((col) => ({ row: buf.row, col }))] : [];
  const scriptLines = [];
  for (let i = top; i < Math.min(buf.lines.length, top + scriptRows); i++) {
    let segs = highlight(buf.lines[i]);
    const sel = buffer.selectedColumns(buf, i);
    if (sel) segs = withSelection(segs, sel[0], sel[1]);
    for (const m of pairMarks) if (m.row === i) segs = withSelection(segs, m.col, m.col + 1, { bold: true, color: theme.accent, underline: true });
    if (i === buf.row && focus === 'script' && !pathMode && !buf.anchor) segs = withCursor(segs, buf.col);
    scriptLines.push(
      <Row key={i} pointer={false} width={inner} segments={[{ text: String(i + 1).padStart(GUTTER - 1) + ' ', color: i === buf.row ? theme.accent : theme.dim }, ...fitSegments(fromColumn(segs, left), codeW)]} />,
    );
  }

  const end = Math.max(0, output.length - back);
  const shown = tailRows(output, end, viewRows, inner);
  const outputRowsEls = shown.map((l, i) => <Row key={i} pointer={false} width={inner} segments={[{ text: l.text, color: OUTPUT_COLOR[l.kind]() }]} />);
  const mood = moodFor({ state: { running, none: !session }, last });
  const feeling = familyMood({ mood });
  useEffect(() => {
    if (family) writeMood('helm', feeling);
  }, [feeling.mood, feeling.reason, family]);
  const top1 = topLine({ face: FACES[mood], title: 'Helm', views: VIEWS, view: focus === 'console' && pathMode ? returnTo.current : focus, context: headerContext({ path, dirty, session, running }), width: columns, compact: true });

  geo.current = { top, left, view: focus === 'console' && !pathMode ? 'console' : 'script', scriptRows, scriptH, viewRows, tabs: top1.tabs };
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
  } else if (focus === 'console' && !pathMode) {
    main = (
      <Panel title="Console" hint={back ? `${back} lines up` : undefined} width={columns} height={body} focused>
        {outputRowsEls}
      </Panel>
    );
  } else {
    main = (
      <>
        <Panel title="Script" hint={`${buf.row + 1}:${buf.col + 1}${buffer.selection(buf) ? ` · ${buffer.selectedText(buf).length} selected` : ''}`} width={columns} height={scriptH} focused={focus === 'script' && !pathMode}>
          {scriptLines}
        </Panel>
        <Panel title="Output" hint={back ? `${back} lines up` : undefined} width={columns} height={outputH} focused={false}>
          {outputRowsEls}
        </Panel>
      </>
    );
  }

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Row pointer={false} width={columns} segments={top1.segments} />
      {main}
      {showPrompt && !help ? <PromptBox value={prompt.value} cursor={prompt.cursor} focused width={columns} placeholder={pathMode ? PATH_PLACEHOLDER[pathMode] : 'PowerShell command (tab completes, ctrl+t leaves)'} bang={false} /> : null}
      <StatusLine face={FACES[reaction && !running ? (reaction.mood === 'happy' ? 'happy' : 'worried') : mood]} news={Boolean(reaction) && !running && !pathMode} message={pathMode ? PATH_PLACEHOLDER[pathMode] : running ? 'running… (esc stops)' : reaction ? [{ text: reaction.text }, { text: '  esc', color: theme.dim }] : ''} tone={running && !pathMode ? 'warn' : undefined} keys={pathMode ? '↵ go · esc cancel' : HINTS[focus]} width={columns} />
    </Box>
  );
}
