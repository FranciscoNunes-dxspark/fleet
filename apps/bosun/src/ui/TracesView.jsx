import React, { useEffect, useRef, useState } from 'react';
import { useInput } from 'ink';
import { theme } from '../theme.js';
import { fit, relTime, stringWidth } from '@fleet/kit/text.js';
import { useListNav, useMouse } from '@fleet/kit/ui/hooks.js';
import { Panel, Row } from '@fleet/kit/ui/parts.jsx';
import { copiedNote } from '@fleet/kit/family.js';
import { bar, shortDuration, spanHandoff, spanText, traceSummary, waterfall } from '../traces.js';

/**
 * The traces the crew exported to Bosun's receiver (traces.js's TraceStore, `store`), slowest first;
 * ↵ opens one as a waterfall of its spans across the processes, where ↵ shows a span's attributes and
 * t hands its SQL to Trawl or its request to Hail. `receiver` is { port } once it listens, or { error }.
 * `place` ({ open, at }, App's) keeps the trace open and the row under the cursor while an overlay (a
 * span's attributes) takes this view off the screen.
 */
export function TracesView({ store, receiver, place = { open: null, at: null }, ctx, width, height, active }) {
  const [open, setOpenState] = useState(place.open);
  const setOpen = (id) => {
    place.open = id;
    place.at = null;
    setOpenState(id);
  };
  const openRef = useRef(null);
  openRef.current = open;
  const trace = open ? store.get(open) : null;
  // Gone from the store (past its age, or cleared): back to the list.
  useEffect(() => {
    if (open && !trace) setOpen(null);
  });
  const innerH = height - 2;

  const list = trace ? [] : store.list();
  const spans = trace ? [...trace.spans.values()] : [];
  const rows = trace ? waterfall(spans) : [];
  const summary = trace ? traceSummary(trace) : null;
  const count = trace ? rows.length : list.length;
  const keyOf = (i) => (trace ? rows[i]?.span.spanId : list[i]?.id);
  const [first] = useState(() => {
    for (let i = 0; i < count; i++) if (keyOf(i) === place.at) return i;
    return 0;
  });
  const nav = useListNav(count, innerH, { resetKey: open ?? '', start: open === place.open && place.at ? first : 0, keyOf });
  place.at = keyOf(nav.index) ?? null;

  // esc goes back from a trace to the list: this view's, not the app's.
  useEffect(
    () => () => {
      ctx.claimsKey = null;
    },
    [],
  );
  ctx.claimsKey = active ? (input, key) => Boolean(openRef.current) && key.escape : null;

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    if (ctx.claimsKey?.(input, key)) {
      ctx.claimed?.();
      return setOpen(null);
    }
    if (nav.handle(input, key)) return;
    if (!trace) {
      const t = list[nav.index];
      if (input === 'c' && list.length) {
        store.clear();
        return ctx.note('Cleared the traces.');
      }
      if (!t) return;
      if (key.return) return setOpen(t.id);
      if (input === 'y') return ctx.copy(t.id, 'the trace id');
      return;
    }
    const r = rows[nav.index];
    if (!r) return;
    if (key.return) return ctx.showText(`${r.span.service} · ${r.span.name}`, spanText(r.span, summary.start));
    if (input === 't') {
      const h = spanHandoff(r.span);
      if (!h) return ctx.note('This span has no SQL (db.query.text, db.statement) or HTTP request (http.request.method and url.full) to hand on.');
      ctx.copy(h.line, h.what);
      return ctx.note(copiedNote(h.app, h.line), 'ok');
    }
    if (input === 'y') return ctx.copy(r.span.spanId, 'the span id');
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    if (e.wheel) return nav.scrollBy(e.wheel * 3);
    if (nav.pick(e.y - 1) && e.double) keys('', { return: true });
  });

  const W = width - 2;
  const listening = receiver?.port ? `127.0.0.1:${receiver.port}` : receiver?.error ? 'not listening' : receiver === null ? 'off' : 'starting';
  if (!trace) {
    const empty = !list.length;
    return (
      <Panel title="Traces" hint={`${list.length} · OTLP ${listening}`} width={width} height={height} focused={active}>
        {empty ? (
          <Row
            pointer={false}
            width={W}
            segments={[
              {
                text: receiver?.error
                  ? `  The traces receiver couldn't listen: ${receiver.error}`
                  : receiver === null
                    ? '  Traces are off (/settings).'
                    : `  No traces yet. The processes Bosun starts export to OTLP on 127.0.0.1${receiver?.port ? `:${receiver.port}` : ''} (OTEL_EXPORTER_OTLP_ENDPOINT); one with an OpenTelemetry SDK shows here.`,
                color: theme.dim,
              },
            ]}
          />
        ) : null}
        {list.slice(nav.offset, nav.offset + innerH).map((t, i) => (
          <Row
            key={t.id}
            width={W}
            selected={nav.offset + i === nav.index}
            focused={active}
            segments={[
              { text: fit(shortDuration(t.duration), 9, 'right'), color: t.errors ? theme.del : theme.accent, bold: true },
              { text: '  ' },
              { text: fit(t.name, 32), strong: true },
              { text: `  ${t.services.join(' → ')}`, color: theme.info },
              { text: `  ${t.spans} span${t.spans === 1 ? '' : 's'}`, color: theme.dim },
              ...(t.errors ? [{ text: `  ${t.errors} failed`, color: theme.del }] : []),
              { text: `  ${relTime(t.end || t.seen)}`, color: theme.dim },
            ]}
          />
        ))}
      </Panel>
    );
  }

  // The waterfall: the service, the span's name (indented under its parent), its bar and how long it took.
  const serviceW = Math.min(16, Math.max(7, ...spans.map((s) => stringWidth(s.service))));
  const nameW = Math.max(12, Math.min(40, Math.floor(W * 0.35)));
  const durW = 9;
  const barW = Math.max(4, W - 2 - serviceW - 2 - nameW - 2 - durW - 2);
  return (
    <Panel title={`Trace ${summary.name}`} hint={`${shortDuration(summary.duration)} · ${summary.spans} spans · ${summary.services.join(' → ')} · esc back`} width={width} height={height} focused={active}>
      {rows.slice(nav.offset, nav.offset + innerH).map(({ span, depth }, i) => {
        const b = bar(span, summary.start, summary.duration, barW);
        const failed = span.status?.code === 2;
        const linked = spanHandoff(span);
        return (
          <Row
            key={span.spanId}
            width={W}
            selected={nav.offset + i === nav.index}
            focused={active}
            segments={[
              { text: fit(span.service, serviceW), color: theme.info },
              { text: '  ' },
              { text: fit(`${'  '.repeat(Math.min(depth, 8))}${span.name}`, nameW), strong: true, color: failed ? theme.del : undefined },
              { text: '  ' },
              { text: ' '.repeat(b.before) },
              { text: '█'.repeat(b.len), color: failed ? theme.del : linked?.app === 'trawl' ? theme.add : theme.accent },
              { text: ' '.repeat(b.after) },
              { text: '  ' },
              { text: fit(shortDuration((span.end || span.start) - span.start), durW, 'right'), color: theme.dim },
            ]}
          />
        );
      })}
    </Panel>
  );
}
