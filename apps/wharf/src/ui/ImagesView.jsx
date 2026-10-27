import React from 'react';
import { useInput } from 'ink';
import * as a from '../actions.js';
import { imageName } from '../rows.js';
import { theme } from '../theme.js';
import { fit } from '@fleet/kit/text.js';
import { useListNav, useMouse } from '@fleet/kit/ui/hooks.js';
import { Panel, Row } from '@fleet/kit/ui/parts.jsx';

/** What docker images lists, the ones nothing is tagged with last. */
export function ImagesView({ images, containers, ctx, width, height, active }) {
  const innerH = height - 2;
  const list = [...images].sort((x, y) => Number(x.dangling) - Number(y.dangling) || imageName(x).localeCompare(imageName(y)));
  const nav = useListNav(list.length, innerH, { keyOf: (i) => list[i]?.id });
  const sel = list[nav.index];

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    if (nav.handle(input, key)) return;
    if (input === 'p') return a.prune(ctx, 'images');
    if (!sel) return;
    if (input === 'x') a.removeImage(ctx, sel.id);
    else if (input === 'y') ctx.copy(sel.id, `${imageName(sel)}'s id`);
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    if (e.wheel) return nav.scrollBy(e.wheel * 3);
    nav.pick(e.y - 1);
  });

  const inner = width - 4;
  const nameW = Math.max(14, inner - 12 - 10 - 16 - 4);
  // How many containers use an image, by the name they were made from.
  const uses = (i) => containers.filter((c) => c.image === imageName(i) || (i.repo && c.image === i.repo && i.tag === 'latest')).length;
  return (
    <Panel title="Images" hint={`${list.length}${list.some((i) => i.dangling) ? ` · ${list.filter((i) => i.dangling).length} untagged` : ''}`} width={width} height={height} focused={active}>
      {list.length === 0 ? <Row pointer={false} width={width - 2} segments={[{ text: '  No images. /pull fetches one.', color: theme.dim }]} /> : null}
      {list.slice(nav.offset, nav.offset + innerH).map((image, i) => (
        <Row
          key={image.id}
          width={width - 2}
          selected={nav.offset + i === nav.index}
          focused={active}
          segments={[
            { text: fit(imageName(image), nameW), strong: true, color: image.dangling ? theme.dim : undefined },
            { text: ` ${fit(image.id, 12)}`, color: theme.dim },
            { text: ` ${fit(image.size, 9)}`, color: theme.info },
            { text: ` ${fit(image.created, 15)}`, color: theme.dim },
            ...(uses(image) ? [{ text: ` ${uses(image)} in use`, color: theme.add }] : []),
          ]}
        />
      ))}
    </Panel>
  );
}
