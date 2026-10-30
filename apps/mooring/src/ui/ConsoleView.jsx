import React from 'react';
import { useInput } from 'ink';
import { plainText } from '../format.js';
import { theme } from '../theme.js';
import { useListNav, useMouse } from '@fleet/kit/ui/hooks.js';
import { Panel, Row } from '@fleet/kit/ui/parts.jsx';

// More than this of one command's output is kept; the start is dropped, as a terminal's scrollback is.
export const MAX_LINES = 500;

const split = (text) => {
  const lines = plainText(text).split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
};

/**
 * What the console draws, one row per line: each command with where it ran, its output (standard
 * output, then what it said on standard error) and how it ended. `history` is App's list of
 * { id, host, dir, command, status, code, out, err }.
 */
export function consoleLines(history) {
  const rows = [];
  for (const h of history) {
    rows.push({ id: h.id, kind: 'command', text: h.command, where: `${h.host}:${h.dir}` });
    for (const [kind, text] of [['out', h.out], ['err', h.err]]) {
      const lines = split(text ?? '');
      if (lines.length > MAX_LINES) rows.push({ id: h.id, kind: 'dim', text: `… ${lines.length - MAX_LINES} earlier lines` });
      for (const line of lines.slice(-MAX_LINES)) rows.push({ id: h.id, kind, text: line });
    }
    if (h.status === 'running') rows.push({ id: h.id, kind: 'dim', text: 'running… (x cancels)' });
    else if (h.status === 'cancelled') rows.push({ id: h.id, kind: 'warn', text: 'cancelled' });
    else if (h.status === 'failed') rows.push({ id: h.id, kind: 'bad', text: h.code != null ? `exit ${h.code}` : (h.err ?? 'failed').split('\n')[0] });
  }
  return rows;
}

const COLOURS = () => ({ command: undefined, out: undefined, err: theme.warn, dim: theme.dim, warn: theme.warn, bad: theme.del });

/** Commands run on the server (`$ ls -l` at the prompt), each in the folder the right pane shows. */
export function ConsoleView({ history, conn, ctx, width, height, active }) {
  const innerH = height - 2;
  const rows = consoleLines(history);
  // Follows the newest line as output arrives; scroll up to read, and it stays until the next line.
  const nav = useListNav(rows.length, innerH, { start: Math.max(0, rows.length - 1), resetKey: rows.length });

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    if (nav.handle(input, key)) return;
    if (key.return || input === 'i' || input === '$') return ctx.prefill('$ ');
    if (input === 'x') return ctx.cancelRemote();
    if (input === 'c') return ctx.clearConsole();
    if (input === 'y') {
      const item = history.find((h) => h.id === rows[nav.index]?.id);
      if (item) ctx.copy(plainText(item.out || item.err || ''), `the output of ${item.command}`);
    }
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    if (e.wheel) return nav.scrollBy(e.wheel * 3);
    nav.pick(e.y - 1);
  });

  const hint = conn.session ? `${conn.host.name} · ↵ or $ type a command · x cancel · c clear · y copy its output` : 'not connected';
  return (
    <Panel title="Console" hint={hint} width={width} height={height} focused={active}>
      {!rows.length ? (
        <Row
          pointer={false}
          width={width - 2}
          segments={[{ text: conn.session ? '  Nothing run yet. $ ls -l (or ↵ here) runs it on the server, in the folder the Files view shows.' : '  Not connected: /connect <host>, then $ <command> runs it there.', color: theme.dim }]}
        />
      ) : null}
      {rows.slice(nav.offset, nav.offset + innerH).map((r, i) => (
        <Row
          key={nav.offset + i}
          width={width - 2}
          selected={nav.offset + i === nav.index}
          focused={active}
          pointer={false}
          segments={
            r.kind === 'command'
              ? [{ text: '$ ', color: theme.accent, bold: true }, { text: r.text, strong: true }, { text: `   ${r.where}`, color: theme.dim }]
              : [{ text: `  ${r.text}`, color: COLOURS()[r.kind] }]
          }
        />
      ))}
    </Panel>
  );
}
