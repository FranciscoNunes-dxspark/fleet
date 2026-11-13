import React, { useEffect, useRef } from 'react';
import { useInput } from 'ink';
import * as a from '../actions.js';
import { rowSize, shownPath, size, statusTone, statusWord, duration } from '../exchange.js';
import { theme } from '../theme.js';
import { fit } from '@fleet/kit/text.js';
import { useListNav, useMouse } from '@fleet/kit/ui/hooks.js';
import { Panel, Row } from '@fleet/kit/ui/parts.jsx';

/** A status's colour, read from the theme as it draws. */
export const toneColour = (tone) => ({ ok: theme.add, redirect: theme.info, client: theme.warn, server: theme.del, error: theme.del, tunnel: theme.dim, open: theme.dim })[tone];

/** How an exchange came: plain http, tls (HTTPS read through interception), tun (a tunnel), ✗ (refused), har (imported). */
const how = (ex) => (ex.kind === 'refused' ? '✗' : ex.kind === 'tunnel' ? 'tun' : ex.imported ? 'har' : ex.intercepted ? 'tls' : ex.scheme === 'https' ? 'tls' : 'http');

const clock = (ms) => new Date(ms).toTimeString().slice(0, 8);

/**
 * Everything that passed through, oldest first, as it comes: on the last row, the cursor follows new
 * ones. ↵ shows one; h writes it for Hail; f filters.
 */
export function RequestsView({ list, total, filter, listening, paused, ctx, width, height, active, onCursor }) {
  const innerH = height - 2;
  const nav = useListNav(list.length, innerH, { keyOf: (i) => list[i]?.id, start: Math.max(0, list.length - 1) });
  const sel = list[nav.index];
  // Tells App which exchange the cursor is on, for /hail and the like.
  useEffect(() => {
    onCursor?.(sel ?? null);
  });

  // Following: on the last row (or an empty list), new rows take the cursor with them. Done as this
  // renders, not in an effect after it, so new rows cost one frame rather than a second one moving the cursor.
  const seen = useRef(list.length);
  if (list.length !== seen.current) {
    if (list.length > seen.current && (seen.current === 0 || nav.current() >= seen.current - 1)) nav.setIndex(list.length - 1);
    seen.current = list.length;
  }

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    if (nav.handle(input, key)) return;
    if (input === 'f') return ctx.prefill(`/filter ${filter ? `${filter} ` : ''}`);
    if (input === 'e') return ctx.prefill('/export ');
    if (input === 'c') return a.clear(ctx);
    if (!sel) return;
    if (key.return || input === 'l') ctx.showDetail(sel);
    else if (input === 'h') a.hail(ctx, sel);
    else if (input === 't') a.take(ctx, sel);
    else if (input === 'p') a.passHost(ctx, sel);
    else if (input === 'y') a.copyUrl(ctx, sel);
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    if (e.wheel) return nav.scrollBy(e.wheel * 3);
    if (nav.pick(e.y - 1) && e.double) keys('', { return: true });
  });

  const inner = width - 4;
  const hostW = Math.max(12, Math.min(32, Math.floor(inner * 0.24)));
  const pathW = Math.max(10, inner - hostW - 8 - 7 - 7 - 5 - 9 - 8 - 2);
  const hint = [filter ? `${list.length} of ${total} · ${filter}` : `${total}`, paused ? 'paused' : '', listening ? '' : 'not listening'].filter(Boolean).join(' · ');
  let empty = null;
  if (!total) empty = listening ? `  Nothing yet. Point a client at http://${listening.host}:${listening.port} (the Setup view, 4, says how).` : '  Not listening: /start listens, /import reads a HAR file.';
  else if (!list.length) empty = `  Nothing matches ${filter}. /filter alone shows everything.`;
  return (
    <Panel title="Requests" hint={hint} width={width} height={height} focused={active}>
      {empty ? <Row pointer={false} width={width - 2} segments={[{ text: empty, color: theme.dim }]} /> : null}
      {list.slice(nav.offset, nav.offset + innerH).map((ex, i) => {
        const tone = statusTone(ex);
        const refused = ex.kind === 'refused';
        return (
          <Row
            key={ex.id}
            width={width - 2}
            selected={nav.offset + i === nav.index}
            focused={active}
            segments={[
              { text: `${clock(ex.at)} `, color: theme.dim },
              { text: fit(ex.method, 7), strong: true },
              { text: fit(statusWord(ex), 7), color: toneColour(tone), bold: tone === 'server' || tone === 'error' },
              { text: fit(how(ex), 5), color: refused ? theme.del : ex.scheme === 'http' && ex.kind === 'http' ? theme.warn : theme.dim },
              { text: fit(ex.host, hostW), color: theme.info },
              { text: ' ' },
              { text: fit(shownPath(ex), pathW), color: refused ? theme.del : ex.kind === 'http' ? undefined : theme.dim },
              { text: fit(size(rowSize(ex)), 9, 'right'), color: theme.dim },
              { text: fit(duration(ex), 8, 'right'), color: theme.dim },
            ]}
          />
        );
      })}
    </Panel>
  );
}
