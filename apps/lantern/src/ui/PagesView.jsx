import React, { useEffect } from 'react';
import { Box, useInput } from 'ink';
import * as a from '../actions.js';
import { formatMetric } from '../audit.js';
import { withoutIgnored } from '../security.js';
import { metricTone, severityTone } from '../rows.js';
import { theme } from '../theme.js';
import { countFindings } from '@fleet/kit/findings.js';
import { fit, relTime } from '@fleet/kit/text.js';
import { useListNav, useMouse } from '@fleet/kit/ui/hooks.js';
import { Panel, Row } from '@fleet/kit/ui/parts.jsx';
import { PET_WIDTH, Pet } from './Pet.jsx';

const SHORT = { critical: 'C', high: 'H', medium: 'M', low: 'L' };

/** The pages to audit, one row each: its environment, name and URL, its last audit's vitals and findings. */
export function PagesView({ pages, selected, history, ignore, env, ctx, width, height, active }) {
  const innerH = height - 2;
  const nav = useListNav(pages.length, innerH, { start: selected, keyOf: (i) => pages[i] && `${pages[i].env ?? ''} ${pages[i].url}` });
  useEffect(() => {
    if (nav.index !== selected && pages.length) ctx.select(nav.index);
  }, [nav.index]);
  useEffect(() => {
    if (nav.index !== selected) nav.setIndex(selected);
  }, [selected]);

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    if (input === 'A') return a.auditAll(ctx);
    if (nav.handle(input, key)) return;
    // The row the cursor is on now, which a key just before may have moved before this drew.
    const sel = pages[nav.current()];
    if (!sel) return;
    if (key.return || input === 'l') {
      ctx.setView('findings');
      if (!ctx.resultFor(sel.url)) a.audit(ctx, sel);
    } else if (input === 'a') a.audit(ctx, sel);
    else if (input === 's') a.security(ctx, sel);
    else if (input === 'c') ctx.setView('compare');
    else if (input === 'w') ctx.setView('waterfall');
    else if (input === 'o') a.openInBrowser(ctx, sel.url);
    else if (input === 't') a.sharePage(ctx, sel);
    else if (input === 'y') ctx.copy(sel.url, sel.url);
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    if (e.wheel) return nav.scrollBy(e.wheel * 3);
    if (nav.pick(e.y - 1) && e.double) keys('', { return: true });
  });

  const inner = width - 4;
  const envW = pages.some((p) => p.env) ? Math.min(10, Math.max(...pages.map((p) => (p.env ?? '').length)) + 2) : 0;
  const nameW = Math.min(16, Math.max(6, ...pages.map((p) => p.name.length + 1)));
  const statsW = 36;
  const urlW = Math.max(12, inner - envW - nameW - statsW);
  const hint = pages.length ? `${pages.length} page${pages.length === 1 ? '' : 's'}${env ? ` · ${env.name}` : ''}` : 'none';
  return (
    <Panel title="Pages" hint={hint} width={width} height={height} focused={active}>
      {pages.length === 0 ? (
        <>
          <Row pointer={false} width={width - 2} segments={[{ text: '  No pages here. /open <url> audits one; lantern.json ({ "pages": [ … ] }) or .fleet/project.json ("lantern": { "url": … } in each environment) names them.', color: theme.dim }]} />
          {innerH >= 7 ? (
            <Box marginTop={1} marginLeft={2} flexDirection="column" width={PET_WIDTH}>
              <Pet mood="idle" />
            </Box>
          ) : null}
        </>
      ) : null}
      {pages.slice(nav.offset, nav.offset + innerH).map((p, i) => {
        const raw = history[p.url]?.at(-1);
        const found = raw ? withoutIgnored(raw.findings, ignore) : [];
        const counts = countFindings(found);
        const v = raw?.vitals;
        const stats = raw
          ? [
              { text: fit(`LCP ${formatMetric('lcp', v?.lcp)}`, 11), color: metricTone('lcp', v?.lcp) },
              { text: fit(`CLS ${formatMetric('cls', v?.cls)}`, 9), color: metricTone('cls', v?.cls) },
              { text: fit(`INP ${formatMetric('inp', v?.inp)}`, 11), color: metricTone('inp', v?.inp) },
              ...(found.length ? ['critical', 'high', 'medium', 'low'].filter((s) => counts[s]).map((s) => ({ text: `${counts[s]}${SHORT[s]} `, color: severityTone(s), bold: s === 'critical' || s === 'high' })) : [{ text: 'clean', color: theme.add }]),
              { text: ` ${relTime(raw.at)}`, color: theme.dim },
            ]
          : [{ text: 'not audited', color: theme.dim }];
        return (
          <Row
            key={`${p.env ?? ''} ${p.url}`}
            width={width - 2}
            selected={nav.offset + i === nav.index}
            focused={active}
            segments={[
              ...(envW ? [{ text: fit(p.env ?? '', envW), color: env?.name === p.env ? theme.accent : theme.dim, bold: env?.name === p.env }] : []),
              { text: fit(p.name, nameW), strong: true },
              { text: fit(p.url, urlW), color: theme.info },
              { text: ' ' },
              ...stats,
            ]}
          />
        );
      })}
    </Panel>
  );
}
