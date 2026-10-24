import React from 'react';
import { useInput } from 'ink';
import { showAlert } from '../actions.js';
import { openUrl } from '../open.js';
import { theme } from '../theme.js';
import { fit, relTime } from '../text.js';
import { useListNav, useMouse } from './hooks.js';
import { Panel, Row } from './parts.jsx';

/** Sev0 and Sev1 are red, Sev2 yellow, the rest blue. */
export const severityColour = (sev) => (/^Sev[01]$/.test(sev) ? theme.del : sev === 'Sev2' ? theme.warn : theme.info);

const ago = (t) => (t ? `${relTime(Date.parse(t))} ago` : '');

/**
 * The subscription's alerts still firing (Alerts Management, fired within the span), most severe
 * first, and under them the availability tests of the Application Insights in scope.
 */
export function AlertsView({ alerts, scope, ctx, width, height, active }) {
  const fired = alerts?.rows ?? [];
  const tests = alerts?.tests ?? [];
  const top = alerts?.error ?? (alerts?.loading && !fired.length ? 'Looking for alerts…' : !fired.length && alerts ? 'No alerts firing that began in this span. t changes it.' : null);
  const rows = [
    ...(top ? [{ kind: 'note', text: top, error: Boolean(alerts?.error) }] : []),
    ...fired.map((a) => ({ kind: 'alert', a })),
    { kind: 'heading', text: `Availability tests${scope.component ? ` · ${scope.component.name}` : ''}` },
    ...(alerts?.testsError ? [{ kind: 'note', text: alerts.testsError, error: true }] : tests.length ? tests.map((t) => ({ kind: 'test', t })) : [{ kind: 'note', text: alerts?.loading ? 'Looking…' : 'No availability tests ran in this span.' }]),
  ];
  const innerH = height - 2;
  const nav = useListNav(rows.length, innerH, { selectable: (i) => rows[i]?.kind === 'alert' || rows[i]?.kind === 'test', resetKey: alerts?.rows });
  const sel = rows[nav.index];

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    if (nav.handle(input, key)) return;
    if (input === 'c') return ctx.chooseComponent();
    if (sel?.kind === 'alert') {
      if (key.return) return showAlert(ctx, sel.a);
      if (input === 'o' && sel.a.targetId) return openUrl(`https://portal.azure.com/#resource${sel.a.targetId}`).catch((e) => ctx.note(`Couldn't open the browser: ${e.message}`, 'error'));
      if (input === 'y') return ctx.copy(sel.a.name, 'its name');
    }
    if (sel?.kind === 'test') {
      if (key.return || input === 'l') return ctx.logsFor(null, `availabilityResults | where name == '${sel.t.name.replace(/'/g, "\\'")}' | order by timestamp desc | take 100`);
      if (input === 'y') return ctx.copy(sel.t.name, 'its name');
    }
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    if (e.wheel) return nav.scrollBy(e.wheel * 3);
    if (nav.pick(e.y - 1) && e.double) keys('', { return: true });
  });

  const status = alerts?.loading ? 'looking…' : alerts?.error ? 'failed' : `${fired.length} firing · ${alerts?.span?.label ?? ''}`;
  const shown = rows.slice(nav.offset, nav.offset + innerH);
  return (
    <Panel title="Alerts" hint={status} width={width} height={height} focused={active}>
      {shown.map((r, i) => {
        const at = nav.offset + i;
        if (r.kind === 'heading') return <Row key={at} pointer={false} width={width - 2} segments={[{ text: '' }, { text: r.text, color: theme.dim, bold: true }]} />;
        if (r.kind === 'note') return <Row key={at} pointer={false} width={width - 2} segments={[{ text: `  ${r.text}`, color: r.error ? theme.del : theme.dim }]} />;
        if (r.kind === 'alert')
          return (
            <Row
              key={at}
              width={width - 2}
              selected={at === nav.index}
              focused={active}
              segments={[
                { text: fit(r.a.severity, 5), color: severityColour(r.a.severity), bold: true },
                { text: ` ${fit(r.a.name, 34)}`, strong: true },
                { text: ` ${fit(r.a.target, 18)}`, color: theme.info },
                { text: ` ${fit(r.a.signal, 7)}`, color: theme.dim },
                { text: ` ${fit(ago(r.a.fired), 9)}`, color: theme.dim },
                { text: ` ${r.a.description}`, color: theme.dim },
              ]}
            />
          );
        return (
          <Row
            key={at}
            width={width - 2}
            selected={at === nav.index}
            focused={active}
            segments={[
              { text: fit(r.t.failed ? `${r.t.failed} ✗` : '✓', 5, 'right'), color: r.t.failed ? theme.del : theme.add, bold: true },
              { text: ` ${fit(r.t.name, 34)}`, strong: true },
              { text: ` ${fit(`${r.t.total} runs, ${r.t.locations} places`, 18)}`, color: theme.dim },
              { text: ` ${r.t.lastFailure ? `failed ${ago(r.t.lastFailure)}` : `last ran ${ago(r.t.last)}`}`, color: r.t.lastFailure ? theme.del : theme.dim },
              { text: r.t.message ? `  ${r.t.message}` : '', color: theme.dim },
            ]}
          />
        );
      })}
    </Panel>
  );
}
