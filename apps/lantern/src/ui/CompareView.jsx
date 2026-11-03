import React from 'react';
import { useInput } from 'ink';
import * as a from '../actions.js';
import { counterpart } from '../pages.js';
import { withoutIgnored } from '../security.js';
import { compareRows, compareSentence, sideLabel } from '../share.js';
import { metricTone } from '../rows.js';
import { theme } from '../theme.js';
import { countFindings } from '@fleet/kit/findings.js';
import { fit, relTime } from '@fleet/kit/text.js';
import { Panel, Row } from '@fleet/kit/ui/parts.jsx';

/**
 * The two sides Compare shows: { a, b, pageA, pageB, why } where a and b are results (null when not
 * audited) and `why` says what's missing. `mode` is { mode: 'env', other } (the selected page and the
 * same path in another environment), { mode: 'runs' } (its previous run and its latest) or
 * { mode: 'pages', a, b } (two URLs).
 */
export function compareSides({ page, pages, history, mode }) {
  const latest = (url) => history[url]?.at(-1) ?? null;
  if (!page && mode.mode !== 'pages') return { why: 'No page selected.' };
  if (mode.mode === 'pages') {
    const pa = pages.find((p) => p.url === mode.a) ?? { url: mode.a, name: mode.a };
    const pb = pages.find((p) => p.url === mode.b) ?? { url: mode.b, name: mode.b };
    return { a: latest(mode.a), b: latest(mode.b), pageA: pa, pageB: pb };
  }
  const envs = [...new Set(pages.map((p) => p.env).filter(Boolean))].filter((e) => e !== page.env);
  if (mode.mode === 'env' && page.env && envs.length) {
    const other = envs.includes(mode.other) ? mode.other : envs[0];
    const pb = counterpart(pages, page, other);
    return { a: latest(page.url), b: pb ? latest(pb.url) : null, pageA: page, pageB: pb, other, envs };
  }
  const runs = history[page.url] ?? [];
  if (runs.length < 2) return { pageA: page, pageB: page, why: `${page.url} has ${runs.length ? 'one audit' : 'no audits'}: compare needs two runs of it${page.env ? '' : ' (or pages in two environments)'}. a audits it again.` };
  return { a: runs.at(-2), b: runs.at(-1), pageA: page, pageB: page, runs: true };
}

/** The same page in two environments, or two runs of it: each vital, the weight, the requests, the findings by category. */
export function CompareView({ page, pages, history, mode, ignore, ctx, width, height, active }) {
  const sides = compareSides({ page, pages, history, mode });
  const shown = (r) => r && { ...r, findings: withoutIgnored(r.findings, ignore), counts: countFindings(withoutIgnored(r.findings, ignore)) };
  const A = shown(sides.a);
  const B = shown(sides.b);

  const keys = async (input) => {
    if (!ctx.viewHasKeys()) return;
    if (input === 'e') {
      if (!sides.envs?.length) return ctx.note('No other environment names this page: .fleet/project.json\'s environments, each with "lantern": { "url": … }.', 'error');
      const i = sides.envs.indexOf(sides.other);
      return ctx.setCompare({ mode: 'env', other: sides.envs[(i + 1) % sides.envs.length] });
    }
    if (input === 'p') return ctx.setCompare({ mode: 'runs' });
    if (input === 'a') {
      if (sides.pageA && !(await a.audit(ctx, sides.pageA))) return;
      if (sides.pageB && sides.pageB.url !== sides.pageA?.url) await a.audit(ctx, sides.pageB);
      return;
    }
    if (input === 'y' && A && B) ctx.copy(a.compareText(A, B), 'the comparison');
  };
  useInput(keys, { isActive: active });

  const inner = width - 4;
  const colW = Math.max(14, Math.min(28, Math.floor((inner - 16) / 3)));
  const rows = [];
  const line = (segs) => rows.push(segs);
  if (sides.why) line([{ text: `  ${sides.why}`, color: theme.dim }]);
  else {
    const la = A ? sideLabel(A, B) : sides.pageA?.env ?? 'a';
    const lb = B ? sideLabel(B, A) : sides.pageB?.env ?? 'b';
    line([{ text: '  ' }, { text: fit(la, colW + 16), bold: true, color: theme.accent }, { text: 'vs  ', color: theme.dim }, { text: lb, bold: true, color: theme.accent }]);
    line([{ text: `  ${fit(sides.pageA?.url ?? '', colW + 16)}    ${sides.pageB?.url ?? '(no such page)'}`, color: theme.dim }]);
    if (A && B) line([{ text: `  ${A.at ? relTime(A.at) : ''}`.padEnd(colW + 18), color: theme.dim }, { text: B.at ? relTime(B.at) : '', color: theme.dim }]);
    line([{ text: '' }]);
    if (!A || !B) line([{ text: `  ${!A ? sides.pageA?.url : sides.pageB?.url ?? 'The other page'} hasn't been audited: a audits both.`, color: theme.dim }]);
    else {
      line([{ text: `  ${compareSentence(A, B)}`, strong: true }]);
      line([{ text: '' }]);
      line([{ text: `  ${fit('', 16)}${fit(lb === la ? 'a' : la, colW)}${fit(lb, colW)}change`, color: theme.dim }]);
      for (const r of compareRows(A, B)) {
        const metric = ['lcp', 'cls', 'inp', 'ttfb', 'fcp'].includes(r.id);
        line([
          { text: `  ${fit(r.label, 16)}`, strong: true },
          { text: fit(r.a, colW), color: metric ? metricTone(r.id, A.vitals?.[r.id]) : theme.dim },
          { text: fit(r.b, colW), color: metric ? metricTone(r.id, B.vitals?.[r.id]) : theme.dim },
          { text: r.delta, color: !r.delta || /same/.test(r.delta) ? theme.dim : r.worse ? theme.del : theme.add },
        ]);
      }
      if (!A.lab || !B.lab) line([{ text: '  One side has no lab numbers (no browser when it was audited).', color: theme.warn }]);
    }
  }
  const hint = sides.runs ? 'previous run · latest' : sides.other ? `with ${sides.other} · e another` : mode.mode === 'pages' ? 'two pages' : '';
  return (
    <Panel title={`Compare${page ? ` · ${page.name}` : ''}`} hint={hint} width={width} height={height} focused={active}>
      {rows.slice(0, height - 2).map((segs, i) => (
        <Row key={i} pointer={false} width={width - 2} segments={segs} />
      ))}
    </Panel>
  );
}
