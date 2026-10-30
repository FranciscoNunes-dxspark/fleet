import React from 'react';
import { useInput } from 'ink';
import * as a from '../actions.js';
import { dateText, sizeText } from '../format.js';
import { theme } from '../theme.js';
import { fit } from '@fleet/kit/text.js';
import { useListNav, useMouse } from '@fleet/kit/ui/hooks.js';
import { Panel, Row } from '@fleet/kit/ui/parts.jsx';

const isDir = (e) => e.kind === 'dir' || e.isDir;

/** A folder's path cut from the left to fit: the end of it is what says where you are. */
export const shortPath = (path, max) => (path.length <= max ? path : `…${path.slice(path.length - Math.max(1, max - 1))}`);

/** The entries a pane shows: all of them, or without those starting with a dot. */
export const visibleEntries = (entries, hidden) => (hidden ? entries : entries.filter((e) => !e.name.startsWith('.')));

/** What `side` has under the cursor, or what is marked there, when anything is. */
export function selectionOf(pane, visible, index) {
  const marked = visible.filter((e) => pane.marks.has(e.name));
  return marked.length ? marked : visible[index] ? [visible[index]] : [];
}

function PaneRows({ pane, visible, nav, width, height, focused, status }) {
  const dated = width >= 52;
  const nameW = Math.max(8, width - 2 - 4 - 8 - (dated ? 13 : 0));
  return (
    <>
      {status ? <Row pointer={false} width={width} segments={[{ text: `  ${status}`, color: theme.dim }]} /> : null}
      {visible.slice(nav.offset, nav.offset + height).map((e, i) => {
        const marked = pane.marks.has(e.name);
        const dir = isDir(e);
        return (
          <Row
            key={e.name}
            width={width}
            selected={nav.offset + i === nav.index}
            marked={marked}
            focused={focused}
            segments={[
              { text: marked ? '+' : ' ', color: theme.accent, bold: true },
              { text: dir ? '▸ ' : e.kind === 'link' ? '↪ ' : '  ', color: theme.info },
              { text: fit(e.name, nameW), color: dir ? theme.info : e.kind === 'file' ? undefined : theme.dim, bold: dir },
              { text: ` ${fit(dir ? '' : sizeText(e.size), 8, 'right')}`, color: theme.dim },
              ...(dated ? [{ text: ` ${fit(dateText(e.modified), 12)}`, color: theme.dim }] : []),
            ]}
          />
        );
      })}
    </>
  );
}

/**
 * Two panes: this machine's folder on the left, the server's on the right. ← → (or h l) change panes,
 * ↵ opens a folder, c copies what's marked (or under the cursor) to the other pane's folder.
 */
export function FilesView({ panes, side, conn, hidden, ctx, width, height, active }) {
  const innerH = height - 2;
  const left = Math.floor(width / 2);
  const right = width - left;
  const vis = { local: visibleEntries(panes.local.entries, hidden), remote: visibleEntries(panes.remote.entries, hidden) };
  const navFor = (s) => ({ start: Math.max(0, vis[s].findIndex((e) => e.name === panes[s].select)), resetKey: panes[s].dir, keyOf: (i) => vis[s][i]?.name });
  const navs = {
    local: useListNav(vis.local.length, innerH, navFor('local')),
    remote: useListNav(vis.remote.length, innerH, navFor('remote')),
  };

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    if (key.leftArrow || input === 'h') return ctx.setSide('local');
    if (key.rightArrow || input === 'l') return ctx.setSide('remote');
    // The focus as of the last key (the prop may not have rendered yet).
    const side = ctx.side();
    const pane = ctx.panes[side];
    const nav = navs[side];
    if (side === 'remote' && !conn.session) return;
    if (nav.handle(input, key)) return;
    if (key.backspace || key.delete || input === '-') return a.up(ctx, side);
    if (input === '~') return a.cd(ctx, side, '~');
    if (input === '.') return a.setHidden(ctx);
    if (input === 'm') return a.mkdir(ctx, side);
    const entry = vis[side][nav.current()];
    const picked = () => selectionOf(pane, vis[side], nav.current());
    if (key.return) {
      if (!entry) return;
      return isDir(entry) ? a.enter(ctx, side, entry) : a.info(ctx, side, entry);
    }
    if (input === ' ') {
      if (!entry) return;
      ctx.toggleMark(side, entry.name);
      return nav.handle('j', {});
    }
    if (input === 'c') return a.copyOver(ctx, side, picked());
    if (input === 'r') return a.rename(ctx, side, entry);
    if (input === 'd' || input === 'x') return a.remove(ctx, side, picked());
    if (input === 'i') return a.info(ctx, side, entry);
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    const clicked = e.x < left ? 'local' : 'remote';
    if (e.wheel) return navs[clicked].scrollBy(e.wheel * 3);
    if (clicked !== side) ctx.setSide(clicked);
    if (clicked === 'remote' && !conn.session) return;
    if (navs[clicked].pick(e.y - 1) && e.double) {
      const entry = vis[clicked][navs[clicked].current()];
      if (entry) isDir(entry) ? a.enter(ctx, clicked, entry) : a.info(ctx, clicked, entry);
    }
  });

  const remoteStatus = conn.status === 'connecting' ? `Connecting to ${conn.host?.name}…` : conn.session ? null : conn.problem ? conn.problem.split('\n')[0] : 'Not connected: ↵ on a host in 3, or /connect <host>';
  const status = (s) => (s === 'remote' && remoteStatus ? remoteStatus : panes[s].problem ? panes[s].problem.split('\n')[0] : panes[s].loading && !panes[s].entries.length ? 'Reading…' : !vis[s].length && !panes[s].loading ? 'Empty' : null);
  const hint = (s) => {
    const marked = panes[s].marks.size;
    return `${marked ? `${marked} marked · ` : ''}${vis[s].length}${panes[s].loading ? ' · reading…' : ''}`;
  };
  const title = (s, w) => {
    const name = s === 'local' ? 'This machine' : (conn.host?.name ?? 'Server');
    return `${name}  ${shortPath(panes[s].dir ?? '', Math.max(6, w - name.length - 14))}`;
  };

  return (
    <>
      <Panel title={title('local', left)} hint={hint('local')} width={left} height={height} focused={active && side === 'local'}>
        <PaneRows pane={panes.local} visible={vis.local} nav={navs.local} width={left - 2} height={innerH} focused={active && side === 'local'} status={status('local')} />
      </Panel>
      <Panel title={title('remote', right)} hint={conn.session ? hint('remote') : ''} width={right} height={height} focused={active && side === 'remote'}>
        <PaneRows pane={panes.remote} visible={conn.session ? vis.remote : []} nav={navs.remote} width={right - 2} height={innerH} focused={active && side === 'remote'} status={status('remote')} />
      </Panel>
    </>
  );
}
