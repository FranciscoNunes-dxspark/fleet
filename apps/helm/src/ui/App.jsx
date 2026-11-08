import React, { useEffect, useRef, useState } from 'react';
import { Box, useApp, useInput } from 'ink';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import * as buffer from '../buffer.js';
import { fromColumn, highlight, withCursor } from '../highlight.js';
import { ERROR_MARK } from '../powershell.js';
import { theme } from '../theme.js';
import { VERSION } from '../app.js';
import { useKeyTranslation, useTerminalSize } from '@fleet/kit/ui/hooks.js';
import { Panel, PromptBox, Row, promptHeight } from '@fleet/kit/ui/parts.jsx';
import { StatusLine, topLine } from '@fleet/kit/ui/shell.jsx';
import { fitSegments } from '@fleet/kit/text.js';

const GUTTER = 5;
const MAX_OUTPUT = 5000;
const HINTS = {
  script: 'F5 run · F8 run line · ctrl+s save · ctrl+o open · ctrl+n new · ctrl+t console · ctrl+q quit',
  console: '↵ run · ↑↓ history · pgup/pgdn scroll · ctrl+l clear · ctrl+t script · esc stop',
};
const PATH_PLACEHOLDER = { open: 'path of the script to open (esc cancels)', save: 'path to save the script to (esc cancels)' };

// Ink doesn't report function keys at all (F5 arrives as an empty key), so they are turned into the
// ctrl keys that do the same, before anything else sees them.
const ESC = String.fromCharCode(27);
const FUNCTION_KEYS = { [`${ESC}[15~`]: String.fromCharCode(18), [`${ESC}[19~`]: String.fromCharCode(5) }; // ctrl+r, ctrl+e

// The top line's right side: the script's file (with * while it has unsaved changes) and the PowerShell
// that runs it.
function headerContext({ path, dirty, session, running }) {
  const segs = [];
  if (running) segs.push({ text: 'running', color: theme.warn }, { text: '  ' });
  segs.push({ text: `${path ? basename(path) : 'untitled.ps1'}${dirty ? ' *' : ''}`, color: theme.dim });
  if (session) segs.push({ text: `  ${session.bin}`, color: theme.dim });
  return segs;
}

const OUTPUT_COLOR = { in: () => theme.accent, err: () => theme.del, info: () => theme.dim, out: () => undefined };

// `session` is powershell.js's createSession (or null when no PowerShell is installed); `file` is
// opened at the start. `setTitle` comes from cli.jsx; tests leave it out.
export function App({ session, file, cwd = process.cwd(), setTitle }) {
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
  const [pathMode, setPathMode] = useState(null);
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
  const body = Math.max(8, rows - 2 - promptHeight());
  const scriptH = Math.max(4, Math.floor(body * 0.55));
  const outputH = Math.max(4, body - scriptH);
  const inner = columns - 2;
  const scriptRows = scriptH - 1;
  const outputRows = outputH - 1;
  const codeW = Math.max(10, inner - GUTTER);

  const edit = (fn) => {
    update(fn);
    setDirty(true);
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

  useKeyTranslation((input) => FUNCTION_KEYS[input] ?? input);

  const execute = async (code, label) => {
    if (runningRef.current || !code.trim()) return;
    if (!session) return say('err', 'No PowerShell found.');
    runningRef.current = true;
    setRunning(true);
    setBack(0);
    say('in', label);
    try {
      const r = await session.run(code, (text) => {
        if (text.startsWith(ERROR_MARK)) say('err', text.slice(1));
        else say('out', text);
      });
      if (r.stopped) say('info', 'Stopped. The session starts again with the next run, without its variables.');
    } catch (err) {
      say('err', String(err.message ?? err));
    }
    runningRef.current = false;
    setRunning(false);
  };

  const runScript = () => execute(buffer.textOf(bufRef.current), `▶ Run ${path ? basename(path) : 'script'}`);
  const runLine = () => {
    const line = buffer.currentLine(bufRef.current);
    return execute(line, `▶ ${line.trim()}`);
  };

  function openFile(name) {
    try {
      const full = resolve(cwd, name);
      update(() => buffer.create(readFileSync(full, 'utf8')));
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
    setPathMode(mode);
    setFocus('console');
    const value = mode === 'save' && path ? path : '';
    setPromptNow(value, value.length);
  };

  const submit = () => {
    const value = promptRef.current.value;
    setPromptNow('', 0);
    if (pathMode) {
      const mode = pathMode;
      setPathMode(null);
      setFocus('script');
      if (value.trim()) (mode === 'open' ? openFile : saveFile)(value.trim());
      return;
    }
    if (!value.trim()) return;
    setHistory((h) => [value, ...h.filter((x) => x !== value)].slice(0, 200));
    setRecall(-1);
    execute(value, `PS> ${value}`);
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
    if (!pathMode && (key.upArrow || key.downArrow)) {
      const next = Math.max(-1, Math.min(history.length - 1, recall + (key.upArrow ? 1 : -1)));
      setRecall(next);
      const v = next < 0 ? '' : history[next];
      return set(v, v.length);
    }
    if (key.pageUp) return setBack((b) => Math.min(Math.max(0, output.length - outputRows), b + outputRows - 1));
    if (key.pageDown) return setBack((b) => Math.max(0, b - outputRows + 1));
    if (key.ctrl || key.meta || !input) return;
    const text = input.replace(/\r?\n/g, ' ');
    set(value.slice(0, cursor) + text + value.slice(cursor), cursor + text.length);
  };

  const scriptKeys = (input, key) => {
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
    if (key.tab) return edit((b) => buffer.insert(b, '\t'));
    if (key.ctrl || key.meta || !input) return;
    edit((b) => buffer.insert(b, input));
  };

  useInput((input, key) => {
    if (key.ctrl && input === 'q') {
      if (dirtyRef.current && !quitArmed.current) {
        quitArmed.current = true;
        return say('info', 'The script has unsaved changes: ctrl+s saves, ctrl+q again quits without saving.');
      }
      return exit();
    }
    quitArmed.current = false;
    if ((key.ctrl && input === 'c') || key.escape) {
      if (running) return session.stop();
      if (key.escape && pathMode) {
        setPathMode(null);
        setPromptNow('', 0);
        return setFocus('script');
      }
      return;
    }
    if (key.ctrl && input === 'r') return runScript();
    if (key.ctrl && input === 'e') return runLine();
    if (key.ctrl && input === 's') return path ? saveFile(path) : ask('save');
    if (key.ctrl && input === 'o') return ask('open');
    if (key.ctrl && input === 'n') {
      update(() => buffer.create(''));
      setPath(null);
      setDirty(false);
      return setTop(0);
    }
    if (key.ctrl && input === 'l') return clearOutput();
    if ((key.ctrl && input === 't') || (key.tab && key.shift)) return pathMode ? undefined : setFocus((f) => (f === 'script' ? 'console' : 'script'));
    return focusRef.current === 'script' ? scriptKeys(input, key) : promptKeys(input, key);
  });

  const scriptLines = [];
  for (let i = top; i < Math.min(buf.lines.length, top + scriptRows); i++) {
    let segs = highlight(buf.lines[i]);
    if (i === buf.row && focus === 'script') segs = withCursor(segs, buf.col);
    scriptLines.push(
      <Row key={i} pointer={false} width={inner} segments={[{ text: String(i + 1).padStart(GUTTER - 1) + ' ', color: i === buf.row ? theme.accent : theme.dim }, ...fitSegments(fromColumn(segs, left), codeW)]} />,
    );
  }

  const end = Math.max(0, output.length - back);
  const shown = output.slice(Math.max(0, end - outputRows), end);

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Row pointer={false} width={columns} segments={topLine({ title: 'Helm', context: headerContext({ path, dirty, session, running }), width: columns }).segments} />
      <Panel title="Script" hint={`${buf.row + 1}:${buf.col + 1}`} width={columns} height={scriptH} focused={focus === 'script'}>
        {scriptLines}
      </Panel>
      <Panel title="Output" hint={back ? `${back} lines up` : undefined} width={columns} height={outputH} focused={false}>
        {shown.map((l, i) => (
          <Row key={i} pointer={false} width={inner} segments={[{ text: l.text, color: OUTPUT_COLOR[l.kind]() }]} />
        ))}
      </Panel>
      <PromptBox value={prompt.value} cursor={prompt.cursor} focused={focus === 'console'} width={columns} placeholder={pathMode ? PATH_PLACEHOLDER[pathMode] : 'PowerShell command (ctrl+t to leave the script)'} bang={false} />
      <StatusLine message={pathMode ? PATH_PLACEHOLDER[pathMode] : running ? 'running… (esc stops)' : ''} tone={running && !pathMode ? 'warn' : undefined} keys={pathMode ? '↵ go · esc cancel' : HINTS[focus]} width={columns} />
    </Box>
  );
}
