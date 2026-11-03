import React, { useState } from 'react';
import * as a from '../actions.js';
import { detailText } from '../detail.js';
import { Viewer } from './Viewer.jsx';

/**
 * One exchange over the view (↵ in Requests): the request, the response, headers, bodies and timings,
 * read again as it streams in. Credentials are hidden until s shows them, and hidden again when it's
 * closed. d and r open a body in the data viewer; h, t and p are the Requests view's.
 */
export function DetailView({ ex, ctx, width, height, active, onClose }) {
  const [secrets, setSecrets] = useState(false);
  const { title, text, hidden } = detailText(ex, { secrets });
  const onKey = (input) => {
    if (input === 's') {
      if (!hidden && !secrets) return ctx.note('Nothing is hidden in this one.');
      return setSecrets((s) => !s);
    }
    if (input === 'd') return a.bodyData(ctx, ex, 'response', { secrets });
    if (input === 'r') return a.bodyData(ctx, ex, 'request', { secrets });
    if (input === 'h') return a.hail(ctx, ex);
    if (input === 't') return a.take(ctx, ex);
    if (input === 'p') return a.passHost(ctx, ex);
  };
  const hint = secrets ? 's hides the credentials · ' : hidden ? `${hidden} hidden, s shows · ` : '';
  return <Viewer title={title} text={text} hint={hint} ctx={ctx} width={width} height={height} active={active} onClose={onClose} onKey={onKey} passKeys={['s', 'd', 'r', 'h', 't', 'p']} />;
}
