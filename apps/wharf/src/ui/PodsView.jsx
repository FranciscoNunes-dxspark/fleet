import React from 'react';
import { useInput } from 'ink';
import * as k from '../kubeactions.js';
import { ageOf } from '../kube.js';
import { podRows, podTone, shortBytes } from '../rows.js';
import { theme } from '../theme.js';
import { fit } from '@fleet/kit/text.js';
import { useListNav, useMouse } from '@fleet/kit/ui/hooks.js';
import { Panel, Row } from '@fleet/kit/ui/parts.jsx';

/**
 * The cluster's pods (kubectl's current context), a namespace's together under its name, the ones that
 * are not well first. Beside each running pod its CPU and memory, when the cluster has a metrics server
 * and there's room. `kube` is App's { pods, top, namespace, context, problem }, null until first read.
 */
export function PodsView({ kube, ctx, width, height, active }) {
  const innerH = height - 2;
  const pods = kube?.pods ?? [];
  const rows = podRows(pods);
  const nav = useListNav(rows.length, innerH, { selectable: (i) => Boolean(rows[i]?.p), keyOf: (i) => (rows[i]?.p ? `${rows[i].p.namespace}/${rows[i].p.name}` : `# ${rows[i]?.heading}`) });
  const sel = rows[nav.index]?.p;

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    if (nav.handle(input, key)) return;
    if (!sel) return;
    const id = `${sel.namespace}/${sel.name}`;
    if (key.return || input === 'l') k.showLogs(ctx, id);
    else if (input === 'x') k.deletePod(ctx, id);
    else if (input === 'r') k.rollout(ctx, id);
    else if (input === 'i') k.describe(ctx, id);
    else if (input === 'y') ctx.copy(sel.name, `${sel.name}`);
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    if (e.wheel) return nav.scrollBy(e.wheel * 3);
    if (nav.pick(e.y - 1) && e.double) keys('', { return: true });
  });

  const inner = width - 4;
  const showUsage = inner >= 90 && kube?.top?.size > 0;
  const showNode = inner >= 70;
  const nameW = Math.max(16, Math.min(44, Math.floor(inner * 0.34)));
  const subtitle = `${kube?.context ?? ''}${kube?.context ? ' · ' : ''}${kube?.namespace && kube.namespace !== 'all' ? kube.namespace : 'all namespaces'}`;
  const notWell = pods.filter((p) => podTone(p) === 'del').length;

  return (
    <Panel title="Pods" hint={`${subtitle} · ${pods.length}${notWell ? ` · ${notWell} not well` : ''}`} width={width} height={height} focused={active}>
      {!kube ? <Row pointer={false} width={width - 2} segments={[{ text: '  Asking the cluster…', color: theme.dim }]} /> : null}
      {kube?.problem && !pods.length ? <Row pointer={false} width={width - 2} segments={[{ text: `  ${kube.problem.split('\n')[0]} /refresh tries again.`, color: theme.warn }]} /> : null}
      {kube && !kube.problem && !pods.length ? <Row pointer={false} width={width - 2} segments={[{ text: '  No pods here. /namespace all lists every namespace.', color: theme.dim }]} /> : null}
      {rows.slice(nav.offset, nav.offset + innerH).map(({ p, heading, members }, i) => {
        if (heading) {
          const up = members.filter((m) => podTone(m) === 'add').length;
          return (
            <Row key={`# ${heading}`} pointer={false} width={width - 2} segments={[{ text: ` ${heading}`, color: theme.accent, bold: true }, { text: ` ${up}/${members.length}`, color: theme.dim }]} />
          );
        }
        const tone = theme[podTone(p)];
        const use = kube.top?.get(`${p.namespace}/${p.name}`);
        return (
          <Row
            key={`${p.namespace}/${p.name}`}
            width={width - 2}
            selected={nav.offset + i === nav.index}
            focused={active}
            segments={[
              { text: '● ', color: tone },
              { text: fit(p.name, nameW), strong: true },
              { text: ` ${fit(p.ready, 5)}`, color: p.readyCount < p.total ? theme.warn : theme.dim },
              { text: ` ${fit(p.status, 17)}`, color: tone },
              { text: ` ${fit(p.restarts ? String(p.restarts) : '', 4)}`, color: p.restarts > 5 ? theme.del : theme.dim },
              { text: ` ${fit(ageOf(p.created), 4)}`, color: theme.dim },
              ...(showNode ? [{ text: ` ${fit(p.node, 18)}`, color: theme.dim }] : []),
              ...(showUsage ? [{ text: ` ${fit(use ? `${use.cpu}m` : '', 6)} ${fit(use ? shortBytes(use.mem) : '', 6)}`, color: theme.dim }] : []),
            ]}
          />
        );
      })}
    </Panel>
  );
}
