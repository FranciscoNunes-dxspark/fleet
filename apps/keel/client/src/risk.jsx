// Pull request risk (server/domain/risk.js) in the web app: the scores, read apart from the list
// (they take a while the first time), a coloured number for the list and the reasons for the panel.
import { useMemo } from 'react';
import { useApi } from './context.js';
import { t } from './i18n.js';

const TONE = { high: 'bad', medium: 'warn', low: 'ok' };
const LEVEL = { high: 'high risk', medium: 'medium risk', low: 'low risk' };

/** Same pull request: by its key (project/repo/id) and organization. */
const keyOf = (x) => `${x.org || ''}:${x.projectId}/${x.repoId}/${x.id}`;

/** The active pull requests' risks, by pull request; `risk(pr)` gives one, or undefined while they load. */
export function useRisks(enabled = true) {
  const { data } = useApi(enabled ? '/prs/risk' : null);
  const byKey = useMemo(() => new Map((data?.risks || []).map((r) => [keyOf(r), r])), [data]);
  return (pr) => byKey.get(keyOf(pr));
}

/** The score as a coloured number, its level and top reason on hover. */
export function RiskScore({ risk }) {
  if (!risk) return null;
  const top = risk.reasons[0];
  const title = `${t('Risk {score} of 100: {level}', { score: risk.score, level: t(LEVEL[risk.level]) })}${top ? ` · ${t(top.text, top.params)}` : ''}`;
  return <span className={`chip chip-${TONE[risk.level]} risk-score mono`} title={title}>{risk.score}</span>;
}

/** The reasons that add up to the score, biggest first, each with its points. */
export function RiskReasons({ risk }) {
  if (!risk) return null;
  return (
    <div className="risk-reasons">
      <p className="small">
        <RiskScore risk={risk} /> {t('Risk {score} of 100: {level}', { score: risk.score, level: t(LEVEL[risk.level]) })}
      </p>
      {risk.reasons.length ? (
        <ul className="plain-list small">
          {risk.reasons.map((r) => (
            <li key={r.id}>
              <span className="mono muted risk-points">{r.points ? t('+{n}', { n: r.points }) : '·'}</span> {t(r.text, r.params)}
            </li>
          ))}
        </ul>
      ) : <p className="muted small">{t('Nothing adds to it: a small change, with tests, by someone who has worked here.')}</p>}
    </div>
  );
}
