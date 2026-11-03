import React, { useEffect, useRef, useState } from 'react';
import { useInput } from 'ink';
import * as k from '../kubeactions.js';
import { BULLET, theme } from '../theme.js';
import { fit } from '@fleet/kit/text.js';
import { useMouse } from '@fleet/kit/ui/hooks.js';
import { Panel, Row } from '@fleet/kit/ui/parts.jsx';

const TONE = { done: 'add', stalled: 'del', failing: 'del', paused: 'warn', progressing: 'info' };
const podTone = (status) => (status === 'Running' ? 'add' : /BackOff|Err|Error|Invalid|OOM/.test(status) ? 'del' : 'warn');

/** A bar of `n` out of `of`, `w` cells wide. */
const bar = (n, of, w) => {
  const full = of > 0 ? Math.round((Math.min(n, of) / of) * w) : 0;
  return { on: '█'.repeat(full), off: '░'.repeat(w - full) };
};

/**
 * A deployment's rollout, followed over the view (/rollout, w on a pod): the replicas as they change,
 * the new pods and their problems as they happen, read again every `every` ms until it's done. When it
 * stalls or fails, `u` undoes it (kubeactions.js's undoRollout, which asks) and the watch starts over.
 * What it ends with is said once in the activity lines, so it's there after the overlay is closed.
 */
export function RolloutView({ target, every = 2000, ctx, width, height, active, onClose }) {
  const { deployment, namespace } = target;
  const [state, setState] = useState(null);
  const [failed, setFailed] = useState(null);
  // Bumped after an undo, so the reading starts again even when the last one was done.
  const [round, setRound] = useState(0);
  const said = useRef(null);
  const stateRef = useRef(null);
  stateRef.current = state;

  useEffect(() => {
    let live = true;
    let timer;
    const again = async () => {
      let next = null;
      try {
        next = await ctx.kube.rollout(deployment, namespace);
        if (!live) return;
        setState(next);
        setFailed(null);
      } catch (e) {
        if (live) setFailed(k.explainKube(e).message.split('\n')[0]);
      }
      if (!live) return;
      if (next && ['done', 'stalled', 'failing'].includes(next.phase) && said.current !== `${round}:${next.phase}`) {
        said.current = `${round}:${next.phase}`;
        ctx.note(`Rollout of ${namespace}/${deployment}: ${next.message}${next.phase === 'done' ? '' : '\nu in the rollout (or /rollout undo) takes it back to the previous revision.'}`, next.phase === 'done' ? 'ok' : 'error');
      }
      // Done is the end of it; a stalled or failing rollout may still come right, so it's read on.
      if (next?.phase !== 'done') timer = setTimeout(again, every);
    };
    again();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [round]);

  const keys = async (input, key) => {
    if (!ctx.overlayHasKeys()) return;
    if (key.escape || input === 'q') return onClose();
    if (input === 'u') {
      if (await k.undoRollout(ctx, target)) {
        said.current = null;
        setRound((n) => n + 1);
      }
      return;
    }
    // l: the log of the newest pod with a problem, else the first new pod.
    if (input === 'l') {
      const s = stateRef.current;
      const name = s?.problems.at(-1)?.pod ?? s?.pods[0]?.name;
      if (name) ctx.showPodLogs({ name, namespace }, {});
    }
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, () => {});

  const inner = width - 4;
  const rows = [];
  const line = (segments, key) => rows.push(<Row key={key ?? rows.length} pointer={false} width={width - 2} segments={[{ text: ' ' }, ...segments]} />);
  if (!state) line([{ text: failed ? `${failed} It's tried again in a moment.` : 'Asking the cluster…', color: failed ? theme.warn : theme.dim }]);
  else {
    line([{ text: `${BULLET} `, color: theme[TONE[state.phase]] }, { text: fit(state.message, inner - 2), color: theme[TONE[state.phase]], bold: true }]);
    // The problems first: on a short screen they're what must not be cut off.
    for (const [i, pr] of state.problems.slice(-5).entries()) line([{ text: '  ✗ ', color: theme.del }, { text: fit(`${pr.pod}  ${pr.text}`, inner - 5), color: theme.del }], `x ${i}`);
    line([]);
    const w = Math.max(10, Math.min(30, inner - 26));
    for (const [label, n] of [
      ['updated', state.updated],
      ['ready', state.ready],
      ['available', state.available],
    ]) {
      const b = bar(n, state.desired, w);
      line([{ text: fit(label, 10), color: theme.dim }, { text: b.on, color: n >= state.desired ? theme.add : theme.info }, { text: b.off, color: theme.border }, { text: ` ${n}/${state.desired}` }]);
    }
    if (state.total > state.updated) line([{ text: fit('old', 10), color: theme.dim }, { text: `${state.total - state.updated} still running`, color: theme.dim }]);
    line([]);
    line([{ text: state.pods.length ? `New pods (revision ${state.revision ?? '?'})` : 'No new pods yet', color: theme.accent, bold: true }]);
    for (const p of state.pods.slice(0, 8)) line([{ text: '● ', color: theme[podTone(p.status)] }, { text: fit(p.name, Math.min(44, inner - 36)), strong: true }, { text: ` ${fit(p.ready, 5)}`, color: theme.dim }, { text: ` ${fit(p.status, 18)}`, color: theme[podTone(p.status)] }, { text: p.restarts ? ` ${p.restarts} restarts` : '', color: p.restarts > 2 ? theme.del : theme.dim }], `p ${p.name}`);
  }
  const undoable = state && ['stalled', 'failing'].includes(state.phase);
  const hint = [failed && state ? `${failed} · ` : '', state && state.phase !== 'done' ? 'following · ' : '', undoable ? 'u undo · ' : '', 'l log · esc close'].join('');
  return (
    <Panel title={`Rollout ${namespace}/${deployment}`} hint={hint} width={width} height={height} focused={active}>
      {rows.slice(0, height - 2)}
    </Panel>
  );
}
