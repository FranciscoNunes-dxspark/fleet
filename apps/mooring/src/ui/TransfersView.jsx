import React, { useEffect, useState } from 'react';
import { useInput } from 'ink';
import { durationText, percentOf, rateText, sizeText } from '../format.js';
import { etaOf, rateOf } from '../queue.js';
import { theme } from '../theme.js';
import { fit } from '@fleet/kit/text.js';
import { useListNav, useMouse } from '@fleet/kit/ui/hooks.js';
import { Panel, Row } from '@fleet/kit/ui/parts.jsx';

const COLOURS = () => ({ queued: theme.dim, running: theme.info, done: theme.accent, failed: theme.del, cancelled: theme.warn });

/** A bar `width` cells wide, `percent` full. */
export const barText = (percent, width) => {
  const full = Math.round(((percent ?? 0) / 100) * width);
  return `${'█'.repeat(full)}${'░'.repeat(width - full)}`;
};

/** What an item says of itself on its row: where it is, or why it stopped. */
export function itemStatus(item, now) {
  if (item.status === 'queued') return 'waiting';
  if (item.status === 'done') return item.total != null ? `done · ${sizeText(item.total)}` : 'done';
  if (item.status === 'cancelled') return 'cancelled';
  if (item.status === 'failed') return (item.error ?? 'failed').split('\n')[0];
  const percent = percentOf(item.bytes, item.total);
  const eta = etaOf(item, now);
  return [percent == null ? sizeText(item.bytes) : `${percent}%`, rateText(rateOf(item, now)), eta != null ? `${durationText(eta)} left` : ''].filter(Boolean).join(' · ');
}

/** The queue: what is waiting, running, done or failed, each with its progress. */
export function TransfersView({ items, ctx, width, height, active }) {
  const innerH = height - 2;
  const nav = useListNav(items.length, innerH, { keyOf: (i) => items[i]?.id });
  // Speeds and times left change between the queue's own updates.
  const [now, setNow] = useState(Date.now());
  const running = items.some((i) => i.status === 'running');
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  const sel = items[nav.index];

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    if (nav.handle(input, key)) return;
    if (input === 'c') return ctx.queue.clear(['done']);
    if (!sel) return;
    if (input === 'x') return ctx.queue.cancel(sel.id);
    if (input === 'r') return ctx.queue.retry(sel.id);
    if (input === 'd') return ctx.queue.remove(sel.id);
    if (key.return) ctx.showText(`${sel.kind === 'upload' ? 'Upload' : 'Download'} ${sel.name}`, [`from  ${sel.from}`, `to    ${sel.to}`, `state ${itemStatus(sel, Date.now())}`, ...(sel.error ? ['', sel.error] : [])].join('\n'));
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    if (e.wheel) return nav.scrollBy(e.wheel * 3);
    if (nav.pick(e.y - 1) && e.double) keys('', { return: true });
  });

  const counts = ctx.queue.counts();
  const statusW = Math.max(14, Math.floor((width - 4) * 0.42));
  const nameW = Math.max(10, width - 2 - 4 - 12 - statusW - 2);
  return (
    <Panel title="Transfers" hint={`${counts.running} running · ${counts.queued} waiting · ${counts.done} done${counts.failed ? ` · ${counts.failed} failed` : ''} · x cancel · r retry · d remove · c clear done`} width={width} height={height} focused={active}>
      {!items.length ? <Row pointer={false} width={width - 2} segments={[{ text: '  Nothing queued. c in Files copies what is marked (or under the cursor) to the other pane.', color: theme.dim }]} /> : null}
      {items.slice(nav.offset, nav.offset + innerH).map((it, i) => (
        <Row
          key={it.id}
          width={width - 2}
          selected={nav.offset + i === nav.index}
          focused={active}
          segments={[
            { text: it.kind === 'upload' ? '↑ ' : '↓ ', color: COLOURS()[it.status], bold: true },
            { text: fit(it.name, nameW), strong: true },
            { text: ` ${it.status === 'running' ? barText(percentOf(it.bytes, it.total), 10) : ' '.repeat(10)}`, color: theme.info },
            { text: `  ${fit(itemStatus(it, now), statusW)}`, color: it.status === 'failed' ? theme.del : theme.dim },
          ]}
        />
      ))}
    </Panel>
  );
}
