import React from 'react';
import { useInput } from 'ink';
import * as a from '../actions.js';
import { summarize, summaryLine } from '../plan.js';
import { ACTION_MARK, ACTION_WORD, actionTone, changeRows, severityTone, siteOf, worstSeverity } from '../rows.js';
import { theme } from '../theme.js';
import { costWords, totalWords } from '../costs.js';
import { fit } from '@fleet/kit/text.js';
import { useListNav, useMouse } from '@fleet/kit/ui/hooks.js';
import { Panel, Row } from '@fleet/kit/ui/parts.jsx';

/** A change's monthly cost in its column: more in yellow, less in green, and what has no figure dim. */
function costCell(cost, currency, w) {
  const text = costWords(cost, currency);
  const color = cost?.status === 'priced' && Math.round(cost.delta * 100) !== 0 ? (cost.delta > 0 ? theme.warn : theme.add) : theme.dim;
  return { text: ` ${fit(text, w - 1)}`, color };
}

const SHORT = { critical: 'crit', high: 'high', medium: 'med', low: 'low' };

/** A change's security marker: "! high" (its worst finding, +n more), in that severity's colour; blank when none. */
function securityCell(findings, w) {
  const worst = worstSeverity(findings);
  const text = worst ? `! ${SHORT[worst] ?? worst}${findings.length > 1 ? `+${findings.length - 1}` : ''}` : '';
  return { text: ` ${fit(text, w - 1)}`, color: severityTone(worst), bold: worst === 'critical' || worst === 'high' };
}

/**
 * The changes a plan makes, what loses something first: the action's mark, the address, how many
 * attributes change, and why (a replacement's cause); `security` ({ address → findings }) marks what
 * it would deploy insecurely ("! high"). With `drifted`, what changed outside the code.
 */
export function ChangesView({ changes, drifted = false, costs, security, empty, hint: extra, showAll, ctx, width, height, active }) {
  const innerH = height - 2;
  const list = drifted ? changes : changeRows(changes, { all: showAll });
  const nav = useListNav(list.length, innerH, { keyOf: (i) => list[i]?.address });
  const sel = list[nav.index];

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    // In Changes, g is what depends on what (home still goes to the top).
    if (input === 'g' && !drifted) return a.showDepends(ctx, sel);
    if (nav.handle(input, key)) return;
    if (input === 'a' && !drifted) return ctx.toggleAll();
    if (!sel) return;
    if (key.return || input === 'l') a.showChange(ctx, sel, { drifted });
    else if (input === 't') a.shareDeclaration(ctx, sel);
    else if (input === 's') a.shareSite(ctx, sel);
    else if (input === 'y') ctx.copy(sel.address);
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    if (e.wheel) return nav.scrollBy(e.wheel * 3);
    if (nav.pick(e.y - 1) && e.double) keys('', { return: true });
  });

  const inner = width - 4;
  const addrW = Math.max(24, Math.min(56, Math.floor(inner * 0.4)));
  const hidden = drifted ? 0 : changes.length - list.length;
  const total = costs?.pending ? 'pricing…' : costs?.error ? 'no prices' : totalWords(costs, { short: true });
  const hint = drifted ? `${changes.length} changed outside${extra ? ` · ${extra}` : ''}` : [summaryLine(summarize(changes)) || 'no changes', hidden ? `${hidden} unchanged (a)` : '', total ? `cost ${total}` : '', extra].filter(Boolean).join(' · ');
  // The cost column only once there are costs, so a plan that isn't priced keeps its room.
  const costW = costs?.byAddress ? 15 : 0;
  // The security column only when something in the plan was found insecure.
  const secW = !drifted && security && Object.keys(security).length ? 9 : 0;
  return (
    <Panel title={drifted ? 'Drift' : 'Changes'} hint={hint} width={width} height={height} focused={active}>
      {!list.length ? <Row pointer={false} width={width - 2} segments={[{ text: `  ${empty}`, color: theme.dim }]} /> : null}
      {list.slice(nav.offset, nav.offset + innerH).map((c, i) => {
        const n = c.diff.filter((d) => !d.noise).length;
        return (
          <Row
            key={`${c.address}:${i}`}
            width={width - 2}
            selected={nav.offset + i === nav.index}
            focused={active}
            segments={[
              { text: `${drifted ? '~' : ACTION_MARK[c.action]} `, color: drifted ? theme.warn : actionTone(c.action), bold: true },
              { text: fit(c.address, addrW), strong: true, color: ['noop', 'ignore'].includes(c.action) ? theme.dim : undefined },
              { text: ` ${fit(drifted ? 'drifted' : ACTION_WORD[c.action], 10)}`, color: drifted ? theme.warn : actionTone(c.action) },
              { text: ` ${fit(n ? `${n} attribute${n === 1 ? '' : 's'}` : '', 14)}`, color: theme.dim },
              ...(costW ? [costCell(costs.byAddress[c.address], costs.currency, costW)] : []),
              ...(secW ? [securityCell(security[c.address], secW)] : []),
              ...(siteOf(c) ? [{ text: ' app ', color: theme.info }] : []),
              ...(c.reason ? [{ text: ` ${c.reason}`, color: theme.dim }] : []),
            ]}
          />
        );
      })}
    </Panel>
  );
}
