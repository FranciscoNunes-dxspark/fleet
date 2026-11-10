// Go / no-go for a release (server/domain/readiness.js) in the web app: read apart from Waiting to
// ship and the approvals (it takes longer the first time), a verdict with its reasons for each
// production environment, and for each pending approval the verdict of the environment it deploys
// to. It never blocks a decision; it sits next to it.
import { useMemo } from 'react';
import { useApi } from './context.js';
import { t } from './i18n.js';
import { Chip } from './ui.jsx';

const TONE = { green: 'ok', amber: 'warn', red: 'bad' };
const LABEL = { green: 'Ready to ship', amber: 'Look before shipping', red: 'Not ready to ship' };
const REASON_TONE = { red: 'text-bad', amber: 'text-warn', info: 'muted' };
const keyOf = (org, key) => `${org || ''}:${key}`;

/**
 * Readiness by environment and by approval: `ofTarget(env)` for a Waiting to ship row,
 * `ofApproval(a)` for a pending approval; undefined while it loads or where none applies.
 */
export function useReadiness(enabled = true) {
  const { data } = useApi(enabled ? '/deploys/readiness' : null);
  return useMemo(() => {
    const targets = new Map((data?.targets || []).map((x) => [keyOf(x.org, x.key), x]));
    const approvals = new Map((data?.approvals || []).map((a) => [keyOf(a.org, a.key), targets.get(keyOf(a.org, a.targetKey))]));
    return {
      loaded: !!data,
      ofTarget: (env) => targets.get(keyOf(env.org, env.key)),
      ofApproval: (a) => approvals.get(keyOf(a.org, a.key)),
    };
  }, [data]);
}

/** The verdict as a chip, its first reason on hover. */
export function ReadinessChip({ r }) {
  if (!r) return null;
  const top = r.reasons[0];
  return <Chip tone={TONE[r.verdict]} title={top ? t(top.text, top.params) : undefined}>{t(LABEL[r.verdict])}</Chip>;
}

/**
 * The verdict and the reasons behind it, folded away when there's nothing to look at. `forName`
 * names the environment (on an approval, where the card is about a run, not a place).
 */
export function Readiness({ r, forName }) {
  if (!r) return null;
  return (
    <details className={`readiness readiness-${r.verdict}`} open={r.verdict !== 'green'}>
      <summary className="small">
        <span className="readiness-title">{t('Go / no-go')}</span> <ReadinessChip r={r} />
        {forName && <span className="muted"> · {t('For {name}. It never blocks the decision.', { name: forName })}</span>}
      </summary>
      {r.reasons.length ? (
        <ul className="plain-list small readiness-reasons">
          {r.reasons.map((x) => <li key={x.id} className={REASON_TONE[x.tone]}>{t(x.text, x.params)}</li>)}
        </ul>
      ) : <p className="muted small">{t('Nothing stands in the way: pipelines green, production healthy, no risky changes or open work going out.')}</p>}
    </details>
  );
}
