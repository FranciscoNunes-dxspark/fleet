import React, { useEffect, useRef, useState } from 'react';
import { useInput } from 'ink';
import { theme } from '../theme.js';
import { fit, stringWidth, wrap } from '@fleet/kit/text.js';
import { useMouse } from '@fleet/kit/ui/hooks.js';
import { Panel, Row } from '@fleet/kit/ui/parts.jsx';
import { commandLine, paneEnded, paneKey, paneOutput, paneScroll, paneStart, paneView } from '../shell.js';

// Every shell a pane started, stopped however Wharf ends (the pane's own cleanup does it otherwise).
const LIVE = new Set();
process.on('exit', () => {
  for (const child of LIVE) {
    try {
      child.kill();
    } catch {}
  }
});

/** The end of `text` that fits in `w` columns: what's being typed stays in sight. */
function tail(text, w) {
  const chars = [...text];
  let i = 0;
  while (i < chars.length && stringWidth(chars.slice(i).join('')) > w) i++;
  return chars.slice(i).join('');
}

/**
 * A shell in a container or pod inside Fleet, where there's no terminal to hand over: the exec runs
 * with pipes (`-i`, no `-t`), its output scrolls above and a line is typed below, sent with ↵ (the
 * pure state is shell.js's pane*). `spawnShell(command, args, options)` starts it (child_process's
 * spawn; demo.js's demoShell in --demo and the tests). ctrl+d or esc closes it, stopping the shell.
 */
export function ShellPane({ title, shell, spawnShell, ctx, width, height, active, onClose }) {
  const [state, setStateRaw] = useState(paneStart);
  const stateRef = useRef(state);
  const setState = (next) => {
    stateRef.current = typeof next === 'function' ? next(stateRef.current) : next;
    setStateRaw(stateRef.current);
  };
  const [said, setSaid] = useState(null);
  const [run, setRun] = useState(0);
  const childRef = useRef(null);

  useEffect(() => {
    let child;
    try {
      child = spawnShell(shell.command, shell.args, { stdio: 'pipe', windowsHide: true });
    } catch (e) {
      setState((s) => paneEnded(s, null, e.message));
      return;
    }
    childRef.current = child;
    LIVE.add(child);
    const out = (chunk) => setState((s) => paneOutput(s, chunk.toString()));
    child.stdout?.on('data', out);
    child.stderr?.on('data', out);
    // Writing to a shell that has gone says EPIPE; its end is said by 'close'.
    child.stdin?.on?.('error', () => {});
    child.on('error', (e) => setState((s) => (s.ended ? s : paneEnded(s, null, /ENOENT/.test(e.message) ? `${shell.command} isn't installed (or isn't on the PATH).` : e.message))));
    child.on('close', (code) => {
      LIVE.delete(child);
      setState((s) => (s.ended ? s : paneEnded(s, code)));
    });
    return () => {
      LIVE.delete(child);
      try {
        child.stdin?.end();
        child.kill();
      } catch {}
    };
  }, [run]);

  const innerW = width - 4;
  // Two lines for the explanation and the prompt, under the border.
  const outH = Math.max(1, height - 2 - 3);

  const keys = (input, key) => {
    if (!ctx.overlayHasKeys()) return;
    const r = paneKey(stateRef.current, input, key);
    setState(r.state);
    setSaid(r.said ?? null);
    if (r.write) childRef.current?.stdin?.write(r.write);
    if (r.kill) {
      setSaid('Stopped the shell.');
      childRef.current?.kill();
    }
    if (r.restart) setRun((n) => n + 1);
    if (r.close) onClose();
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    if (e.wheel) setState((s) => paneScroll(s, -e.wheel * 3));
  });

  // Long lines wrap, so the scrolling counts the lines as drawn.
  const drawn = (state.partial ? [...state.lines, state.partial] : state.lines).flatMap((l) => (l ? wrap(l, innerW) : ['']));
  const view = paneView({ ...state, lines: drawn, partial: '' }, outH);
  const typedW = Math.max(1, innerW - 4);
  const ended = state.ended;
  const status = ended
    ? ended.error
      ? { text: `Couldn't start it: ${ended.error}  ↵ tries again · esc closes`, color: theme.del }
      : { text: `The shell ended${ended.code != null ? ` (${ended.code})` : ''}.  ↵ starts another · esc closes`, color: theme.dim }
    : { text: said ?? 'Line mode: inside Fleet there is no terminal to hand over, so no prompt, no colours and no full-screen programs (vim, top). ↵ sends the line · ctrl+c twice stops it · esc closes', color: said ? theme.warn : theme.dim };
  return (
    <Panel title={`${title} · shell`} hint={view.scroll ? `${view.scroll} lines up · pgdn` : fit(commandLine(shell), Math.max(10, Math.floor(width / 2)))} width={width} height={height} focused={active}>
      <Row pointer={false} width={width - 2} segments={[{ text: ' ' }, { text: fit(status.text, innerW), color: status.color }]} />
      {Array.from({ length: outH }, (_, i) => view.lines[i - (outH - view.lines.length)] ?? null).map((line, i) => (
        <Row key={i} pointer={false} width={width - 2} segments={[{ text: ' ' }, { text: line == null ? '' : fit(line, innerW), color: line?.startsWith('$ ') ? theme.accent : undefined }]} />
      ))}
      <Row
        pointer={false}
        width={width - 2}
        segments={[
          { text: ' $ ', color: ended ? theme.dim : theme.accent, bold: true },
          { text: tail(state.input, typedW) },
          ...(active && !ended ? [{ text: ' ', bg: theme.accent }] : []),
        ]}
      />
    </Panel>
  );
}
