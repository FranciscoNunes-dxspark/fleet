import React, { useEffect, useState } from 'react';
import { useInput } from 'ink';
import * as a from '../actions.js';
import { shortPorts } from '../docker.js';
import { STANDALONE, containerRows, shortBytes, shortCpu, stateLabel, stateTone } from '../rows.js';
import { theme } from '../theme.js';
import { fit } from '@fleet/kit/text.js';
import { useListNav, useMouse } from '@fleet/kit/ui/hooks.js';
import { Panel, Row } from '@fleet/kit/ui/parts.jsx';

const STATE_W = 11;
const CPU_W = 6;
const MEM_W = 6;

/**
 * Every container Docker has: a compose project's together under its name, then the standalone ones.
 * Beside each running container its CPU and memory, when there's room. `onlyRunning` (a, kept by App)
 * leaves out the stopped.
 */
export function ContainersView({ containers, stats, onlyRunning, ctx, width, height, active }) {
  const innerH = height - 2;
  const rows = containerRows(containers, { onlyRunning });
  const nav = useListNav(rows.length, innerH, { selectable: (i) => Boolean(rows[i]?.c), keyOf: (i) => rows[i]?.c?.id ?? `# ${rows[i]?.heading}` });
  const sel = rows[nav.index]?.c;
  // The uptime in a row ("Up 2 hours") changes by itself; the list is read again every few seconds anyway.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    if (nav.handle(input, key)) return;
    if (input === 'a') return ctx.setOnlyRunning(!onlyRunning);
    if (!sel) return;
    if (key.return || input === 'l') a.showLogs(ctx, sel.id);
    else if (input === 's') a.toggle(ctx, sel);
    else if (input === 'r') a.change(ctx, 'restart', sel.id);
    else if (input === 'x') a.remove(ctx, sel.id);
    else if (input === 'i') a.inspect(ctx, sel.id);
    else if (input === 'o') a.open(ctx, sel.id);
    else if (input === 'p') a.change(ctx, sel.state === 'paused' ? 'unpause' : 'pause', sel.id);
    else if (input === 'y') a.copyId(ctx, sel);
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    if (e.wheel) return nav.scrollBy(e.wheel * 3);
    if (nav.pick(e.y - 1) && e.double) keys('', { return: true });
  });

  const inner = width - 4;
  const showUsage = inner >= 90;
  const showImage = inner >= 66;
  const showPorts = inner >= 50;
  const nameW = Math.max(12, Math.min(28, Math.floor(inner * 0.26)));
  const portsW = showPorts ? Math.max(10, Math.min(24, Math.floor(inner * 0.16))) : 0;
  const usageW = showUsage ? CPU_W + MEM_W + 2 : 0;
  const imageW = showImage ? Math.max(8, inner - 3 - nameW - STATE_W - portsW - usageW - 2) : 0;
  const running = containers.filter((c) => c.state === 'running').length;

  return (
    <Panel title="Containers" hint={`${running}/${containers.length} running${onlyRunning ? ' · only running' : ''}`} width={width} height={height} focused={active}>
      {containers.length === 0 ? <Row pointer={false} width={width - 2} segments={[{ text: '  No containers. /pull fetches an image; !docker run -d … starts one.', color: theme.dim }]} /> : null}
      {containers.length > 0 && rows.length === 0 ? <Row pointer={false} width={width - 2} segments={[{ text: '  None running: a shows every container.', color: theme.dim }]} /> : null}
      {rows.slice(nav.offset, nav.offset + innerH).map(({ c, heading, members }, i) => {
        if (heading) {
          const up = members.filter((m) => m.state === 'running').length;
          return (
            <Row
              key={`# ${heading}`}
              pointer={false}
              width={width - 2}
              segments={[
                { text: ` ${heading}`, color: heading === STANDALONE ? theme.dim : theme.accent, bold: true },
                { text: ` ${up}/${members.length}`, color: theme.dim },
              ]}
            />
          );
        }
        const use = stats?.get(c.id.slice(0, 12));
        const tone = theme[stateTone(c)];
        return (
          <Row
            key={c.id}
            width={width - 2}
            selected={nav.offset + i === nav.index}
            focused={active}
            segments={[
              { text: '● ', color: tone },
              { text: fit(c.service ?? c.name, nameW), strong: true },
              { text: ` ${fit(stateLabel(c), STATE_W)}`, color: tone },
              ...(showImage ? [{ text: ` ${fit(c.image, imageW)}`, color: theme.dim }] : []),
              ...(showPorts ? [{ text: ` ${fit(shortPorts(c.ports), portsW)}`, color: theme.info }] : []),
              ...(showUsage ? [{ text: ` ${fit(use ? shortCpu(use.cpu) : '', CPU_W)} ${fit(use ? shortBytes(use.mem) : '', MEM_W)}`, color: theme.dim }] : []),
            ]}
          />
        );
      })}
    </Panel>
  );
}
