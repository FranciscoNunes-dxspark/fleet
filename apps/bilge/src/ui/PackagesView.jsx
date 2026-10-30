import React from 'react';
import { useInput } from 'ink';
import * as a from '../actions.js';
import { denied, licenceKind } from '../audit.js';
import { FILTERS, SEVERITY_LABEL, bumpTone, licenceOf, licenceTone, packageRows, severityTone } from '../rows.js';
import { bumpOf } from '../versions.js';
import { theme } from '../theme.js';
import { fit } from '@fleet/kit/text.js';
import { useListNav, useMouse } from '@fleet/kit/ui/hooks.js';
import { Panel, Row } from '@fleet/kit/ui/parts.jsx';

/** Every package, the direct ones first: its version, the newest one (once asked), its licence, and its advisories. */
export function PackagesView({ data, found, filter, deny, ctx, width, height, active }) {
  const innerH = height - 2;
  const latest = data?.latest ?? null;
  const list = data ? packageRows(data.packages, { filter: filter.filter, manifest: filter.manifest, latest, found, deny }) : [];
  const nav = useListNav(list.length, innerH, { keyOf: (i) => list[i]?.key, resetKey: `${filter.filter}:${filter.manifest}` });
  const sel = list[nav.index];
  const findingOf = (p) => found.find((f) => f.key === p.key);

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    if (nav.handle(input, key)) return;
    if (input === 'a') return ctx.showPackages({ ...filter, filter: FILTERS[(FILTERS.indexOf(filter.filter) + 1) % FILTERS.length] });
    if (input === 'u') return a.outdated(ctx);
    if (key.escape && filter.manifest) return ctx.showPackages({ ...filter, manifest: null });
    if (!sel) return;
    if (key.return || input === 'l') a.showPackage(ctx, sel);
    else if (input === 'f') return findingOf(sel) ? a.fix(ctx, findingOf(sel)) : ctx.note(`${sel.name} ${sel.version} has no known advisories.`);
    else if (input === 'o') a.open(ctx, sel);
    else if (input === 't') a.shareWhere(ctx, sel);
    else if (input === 'y') ctx.copy(`${sel.name}@${sel.version}`);
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    if (e.wheel) return nav.scrollBy(e.wheel * 3);
    if (nav.pick(e.y - 1) && e.double) keys('', { return: true });
  });

  const inner = width - 4;
  const nameW = Math.max(18, Math.min(44, inner - 64));
  const hint = [`${list.length} ${filter.filter === 'all' ? 'packages' : filter.filter}`, filter.manifest ? `in ${filter.manifest} (esc: all)` : '', 'a changes', latest ? '' : 'u newest versions'].filter(Boolean).join(' · ');
  const empty = !data ? '  Reading the lock files…' : !list.length ? (filter.filter === 'outdated' && !latest ? '  u asks the registries for the newest versions.' : '  None.') : null;
  return (
    <Panel title="Packages" hint={hint} width={width} height={height} focused={active}>
      {empty ? <Row pointer={false} width={width - 2} segments={[{ text: empty, color: theme.dim }]} /> : null}
      {list.slice(nav.offset, nav.offset + innerH).map((p, i) => {
        const newest = latest?.get(p.key);
        const bump = bumpOf(p.version, newest?.latest);
        const licence = licenceOf(p, latest);
        const kind = licenceKind(licence);
        const f = findingOf(p);
        return (
          <Row
            key={p.key}
            width={width - 2}
            selected={nav.offset + i === nav.index}
            focused={active}
            segments={[
              { text: fit(p.name, nameW), strong: true, color: p.direct ? undefined : theme.dim },
              { text: ` ${fit(p.version, 12)}`, color: theme.dim },
              { text: ` ${fit(bump ? `→ ${newest.latest}` : newest?.deprecated ? 'deprecated' : '', 12)}`, color: newest?.deprecated ? theme.del : bumpTone(bump) },
              { text: ` ${fit(licence ?? (latest ? '?' : ''), 16)}`, color: denied(licence, deny) ? theme.del : licenceTone(kind) },
              { text: ` ${fit(p.ecosystem, 6)}`, color: theme.dim },
              { text: p.dev ? ' dev' : '    ', color: theme.dim },
              ...(f ? [{ text: ` ${SEVERITY_LABEL[f.severity]}`, color: severityTone(f.severity), bold: true }] : []),
            ]}
          />
        );
      })}
    </Panel>
  );
}
