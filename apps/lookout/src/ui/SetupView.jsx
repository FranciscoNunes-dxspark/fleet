import React from 'react';
import * as a from '../actions.js';
import { DEFAULT_PORT } from '../proxy.js';
import { bosunEnv, httpsProxyLine, proxyLines, trustSteps } from '../setup.js';
import { Viewer } from './Viewer.jsx';

/**
 * What sends traffic through Lookout, and with HTTPS interception how to trust its certificate
 * authority on each system: y copies the HTTPS_PROXY line, b Bosun's env, c the certificate's path,
 * i turns interception on or off. A view, not an overlay: / is the prompt's and space pauses, as everywhere.
 */
export function SetupView({ listening, config, ctx, width, height, active }) {
  const port = listening?.port ?? config.port ?? DEFAULT_PORT;
  const info = ctx.provider.caInfo();
  const caCert = config.intercept && info.exists ? info.paths.cert : null;
  const lines = [
    ...(listening ? [] : [`Not listening now: /start listens on ${port}.`, '']),
    ...proxyLines(port, { caCert }),
    '',
    '── HTTPS ──',
    '',
    ...(config.intercept
      ? [`Intercepted: Lookout reads HTTPS with certificates it signs (i turns it off). Hosts passed through untouched: ${(config.passThrough ?? []).join(', ') || 'none'}.`, `SHA-256 of the authority: ${info.fingerprint ?? '?'}`, '', ...trustSteps(info.paths.cert)]
      : ['Tunnelled: HTTPS passes through as it is, recorded by its host name and size. i (or /intercept on) reads it, through a certificate authority Lookout makes once (it asks first) and you trust once.', ...(info.exists ? ['', ...trustSteps(info.paths.cert)] : [])]),
  ];
  const onKey = (input) => {
    if (input === 'y') return ctx.copy(httpsProxyLine(port), httpsProxyLine(port));
    if (input === 'b') return ctx.copy(`"env": ${JSON.stringify(bosunEnv(port, { caCert }), null, 2)}`, "Bosun's env");
    if (input === 'c') return info.exists ? ctx.copy(info.paths.cert, info.paths.cert) : ctx.note('No certificate authority yet: i (or /intercept on) makes one.');
    if (input === 'i') return a.intercept(ctx, config.intercept ? 'off' : 'on');
  };
  return (
    <Viewer
      title="Setup"
      text={lines.join('\n')}
      hint="y HTTPS_PROXY · b Bosun · c CA path · i HTTPS · "
      ctx={ctx}
      width={width}
      height={height}
      active={active}
      hasKeys={() => ctx.viewHasKeys()}
      onKey={onKey}
      passKeys={['y', 'b', 'c', 'i']}
      search={false}
    />
  );
}
