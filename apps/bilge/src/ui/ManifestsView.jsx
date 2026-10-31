import React from 'react';
import { useInput } from 'ink';
import * as a from '../actions.js';
import { theme } from '../theme.js';
import { fit } from '@fleet/kit/text.js';
import { useListNav, useMouse } from '@fleet/kit/ui/hooks.js';
import { Panel, Row } from '@fleet/kit/ui/parts.jsx';

const KINDS = { lock: 'lock file', project: 'project', manifest: 'no lock', broken: 'unreadable' };

/** The lock files and projects found: how many packages each has, how many it asks for itself, how many are vulnerable. */
export function ManifestsView({ data, found, ctx, width, height, active }) {
  const innerH = height - 2;
  const list = data?.manifests ?? [];
  const nav = useListNav(list.length, innerH, { keyOf: (i) => list[i]?.path });
  const sel = list[nav.index];

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    if (nav.handle(input, key)) return;
    if (!sel) return;
    if (key.return || input === 'l') ctx.showPackages({ filter: 'all', manifest: sel.path });
    else if (input === 't') a.shareManifest(ctx, sel);
    else if (input === 'y') ctx.copy(sel.file, sel.path);
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    if (e.wheel) return nav.scrollBy(e.wheel * 3);
    if (nav.pick(e.y - 1) && e.double) keys('', { return: true });
  });

  const inner = width - 4;
  const pathW = Math.max(20, Math.min(56, Math.floor(inner * 0.4)));
  const vulnerable = (m) => found.filter((f) => f.pkg.where.some((w) => w.path === m.path)).length;
  return (
    <Panel title="Manifests" hint={data ? `${list.length} in ${data.root}` : ''} width={width} height={height} focused={active}>
      {data && !list.length ? <Row pointer={false} width={width - 2} segments={[{ text: '  None here. /move to a folder with a package-lock.json, a packages.lock.json or a .csproj.', color: theme.dim }]} /> : null}
      {list.slice(nav.offset, nav.offset + innerH).map((m, i) => {
        const v = vulnerable(m);
        return (
          <Row
            key={m.path}
            width={width - 2}
            selected={nav.offset + i === nav.index}
            focused={active}
            segments={[
              { text: fit(m.path, pathW), strong: true },
              { text: ` ${fit(m.ecosystem, 6)}`, color: theme.dim },
              { text: ` ${fit(KINDS[m.kind] ?? m.kind, 11)}`, color: m.kind === 'lock' ? theme.dim : theme.warn },
              { text: ` ${fit(`${m.packages.length} packages`, 13)}`, color: theme.info },
              { text: ` ${fit(`${m.packages.filter((p) => p.direct).length} direct`, 10)}`, color: theme.dim },
              { text: ` ${fit(v ? `${v} vulnerable` : '', 13)}`, color: theme.del },
              ...(m.note ? [{ text: ` ${m.note}`, color: theme.dim }] : []),
            ]}
          />
        );
      })}
    </Panel>
  );
}
