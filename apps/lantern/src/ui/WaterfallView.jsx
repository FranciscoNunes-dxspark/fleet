import React from 'react';
import { useInput } from 'ink';
import * as a from '../actions.js';
import { bytes, formatMetric } from '../audit.js';
import { barCells, typeTone } from '../rows.js';
import { theme } from '../theme.js';
import { fit } from '@fleet/kit/text.js';
import { useListNav, useMouse } from '@fleet/kit/ui/hooks.js';
import { Panel, Row } from '@fleet/kit/ui/parts.jsx';

const nameOf = (url) => {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).at(-1);
    return last ? `${last}${u.search}` : u.host;
  } catch {
    return url;
  }
};

/** The selected page's requests in the order they went: status, type, name, size, and a bar from when it started to when it finished. */
export function WaterfallView({ page, result, ctx, width, height, active }) {
  const list = result?.requests ?? [];
  const innerH = height - 3;
  const nav = useListNav(list.length, innerH, { resetKey: `${page?.url} ${result?.at}` });

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    if (nav.handle(input, key)) return;
    // The row the cursor is on now, which a key just before may have moved before this drew.
    const sel = list[nav.current()];
    if (!sel) return;
    if (key.return) a.shareRequest(ctx, sel);
    else if (input === 'l') ctx.showText(nameOf(sel.url), a.requestLines(sel));
    else if (input === 'o') a.openInBrowser(ctx, sel.url);
    else if (input === 'y') ctx.copy(sel.url, sel.url);
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    if (e.wheel) return nav.scrollBy(e.wheel * 3);
    if (nav.pick(e.y - 2) && e.double) keys('', { return: true });
  });

  const inner = width - 4;
  const nameW = Math.max(14, Math.min(34, Math.floor(inner * 0.3)));
  const fixed = 4 + 11 + nameW + 8 + 2;
  const barW = Math.max(10, inner - fixed);
  const total = Math.max(1, ...list.map((r) => r.end ?? r.start));
  const lcp = result?.vitals?.lcp;
  // Where LCP falls on the bar's scale, marked in the heading.
  const lcpAt = lcp && lcp <= total ? Math.min(barW - 1, Math.floor((lcp / total) * barW)) : -1;
  const scale = Array.from({ length: barW }, (_, i) => (i === lcpAt ? '▼' : i === 0 ? '0' : ' ')).join('');
  const hint = result ? `${list.length} requests · ${bytes(result.weight?.total ?? 0)} · ${formatMetric('lcp', total)} to the last${lcp ? ` · ▼ LCP ${formatMetric('lcp', lcp)}` : ''}` : 'not audited';
  let empty = null;
  if (!page) empty = '  No page selected.';
  else if (!result) empty = `  ${page.url} hasn't been audited: a in Pages (or /audit) measures it.`;
  else if (!list.length) empty = `  No requests recorded: ${result.note ?? 'the page was not opened in a browser'}`;
  return (
    <Panel title={`Waterfall${page ? ` · ${page.name}` : ''}`} hint={hint} width={width} height={height} focused={active}>
      <Row pointer={false} width={width - 2} segments={[{ text: `  ${fit('', 4 + 11 + nameW + 8)}`, color: theme.dim }, { text: scale, color: theme.warn }]} />
      {empty ? <Row pointer={false} width={width - 2} segments={[{ text: empty, color: theme.dim }]} /> : null}
      {list.slice(nav.offset, nav.offset + innerH).map((r, i) => {
        const [before, len] = barCells(r, total, barW);
        const bad = r.failed || (r.status ?? 0) >= 400;
        return (
          <Row
            key={`${r.id}:${i + nav.offset}`}
            width={width - 2}
            selected={nav.offset + i === nav.index}
            focused={active}
            segments={[
              { text: fit(r.failed ? '×' : String(r.status ?? '…'), 4), color: bad ? theme.del : (r.status ?? 0) >= 300 ? theme.warn : theme.dim },
              { text: fit(r.type, 11), color: typeTone(r.type) },
              { text: fit(nameOf(r.url), nameW), strong: r.main },
              { text: fit(r.size ? bytes(r.size) : '', 8, 'right'), color: theme.dim },
              { text: '  ' },
              { text: ' '.repeat(before) },
              { text: '█'.repeat(len), color: bad ? theme.del : typeTone(r.type) },
            ]}
          />
        );
      })}
    </Panel>
  );
}
