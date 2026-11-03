import React from 'react';
import { useInput } from 'ink';
import * as a from '../actions.js';
import { CATEGORY_LABEL, CATEGORY_SHORT, filterFindings, vitalsLine } from '../audit.js';
import { FILTER_CATEGORIES, FILTER_SEVERITIES, SEVERITY_LABEL, severityTone } from '../rows.js';
import { theme } from '../theme.js';
import { findingsLine } from '@fleet/kit/findings.js';
import { fit } from '@fleet/kit/text.js';
import { useListNav, useMouse } from '@fleet/kit/ui/hooks.js';
import { Panel, Row } from '@fleet/kit/ui/parts.jsx';

const next = (list, v) => list[(list.indexOf(v) + 1) % list.length];

/** Everything found on the selected page, worst first, by category and severity as filtered (f, s). */
export function FindingsView({ page, result, filter, ctx, width, height, active }) {
  const list = result ? filterFindings(result.findings, filter) : [];
  // A line for the page's lab numbers (or why there are none), above the list.
  const top = result ? 1 : 0;
  const innerH = height - 2 - top;
  const nav = useListNav(list.length, innerH, { resetKey: `${page?.url} ${filter.category} ${filter.min}`, keyOf: (i) => list[i] && `${list[i].rule} ${list[i].selector ?? list[i].url ?? list[i].cookie ?? ''}` });

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    if (input === 'f') return ctx.setFilter((f) => ({ ...f, category: next(FILTER_CATEGORIES, f.category) }));
    if (input === 's') return ctx.setFilter((f) => ({ ...f, min: next(FILTER_SEVERITIES, f.min) }));
    if (input === 'a' && page) return a.audit(ctx, page);
    if (nav.handle(input, key)) return;
    // The row the cursor is on now, which a key just before may have moved before this drew.
    const sel = list[nav.current()];
    if (!sel) return;
    if (key.return || input === 'l') a.showFinding(ctx, sel);
    else if (input === 'x') a.ignore(ctx, sel);
    else if (input === 'o') a.openInBrowser(ctx, sel.helpUrl ?? sel.url ?? sel.where);
    else if (input === 'y') ctx.copy(sel.selector ?? sel.url ?? sel.where, sel.selector ? 'the selector' : 'the URL');
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    if (e.wheel) return nav.scrollBy(e.wheel * 3);
    if (nav.pick(e.y - 1 - top) && e.double) keys('', { return: true });
  });

  const inner = width - 4;
  const titleW = Math.max(20, Math.floor(inner * 0.55));
  const filterWords = [filter.category === 'all' ? '' : CATEGORY_LABEL[filter.category], filter.min === 'all' ? '' : `${filter.min} and worse`].filter(Boolean).join(', ');
  const hint = result ? [findingsLine(result.counts) || 'nothing found', filterWords ? `showing ${filterWords}` : ''].filter(Boolean).join(' · ') : 'not audited';
  let empty = null;
  if (!page) empty = '  No page selected: 1 lists them, /open <url> audits one.';
  else if (!result) empty = `  ${page.url} hasn't been audited: a audits it (three runs in a headless Chrome, axe-core, its links, headers and certificate).`;
  else if (!list.length) empty = filterWords ? `  Nothing that is ${filterWords} (f and s change what is shown).` : '  Nothing found on this page.';
  return (
    <Panel title={`Findings${page ? ` · ${page.env ? `${page.env} ` : ''}${page.name}` : ''}`} hint={hint} width={width} height={height} focused={active}>
      {result ? <Row pointer={false} width={width - 2} segments={[{ text: `  ${result.lab ? `${vitalsLine(result.vitals)}  (lab, median of ${result.runs})` : result.note ?? result.error ?? ''}`, color: result.lab ? theme.dim : theme.warn }]} /> : null}
      {empty ? <Row pointer={false} width={width - 2} segments={[{ text: empty, color: theme.dim }]} /> : null}
      {list.slice(nav.offset, nav.offset + innerH).map((f, i) => (
        <Row
          key={`${nav.offset + i}`}
          width={width - 2}
          selected={nav.offset + i === nav.index}
          focused={active}
          segments={[
            { text: fit(SEVERITY_LABEL[f.severity], 5), color: severityTone(f.severity), bold: true },
            { text: `${CATEGORY_SHORT[f.category] ?? f.category} `, color: theme.dim },
            { text: fit(f.title, titleW), strong: true },
            { text: ' ' },
            { text: fit(f.selector ?? f.wcag ?? f.host ?? f.url ?? f.rule, Math.max(8, inner - titleW - 12)), color: theme.info },
          ]}
        />
      ))}
    </Panel>
  );
}
