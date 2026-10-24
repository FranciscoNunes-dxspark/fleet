import { Link } from 'react-router-dom';
import { ColumnChart } from '../charts.jsx';
import { useApi, useApp } from '../context.js';
import { age, date, hours, pct } from '../format.js';
import { Chip, ErrorBox, Loading } from '../ui.jsx';
import { t } from '../i18n.js';
import { useProjectLabel } from '../orgs.js';
import { DEPLOY_STATUS } from './DeployDetail.jsx';

// DORA performance bands (see server/domain/delivery.js).
const BAND = {
  elite: { tone: 'ok', label: 'Elite' },
  high: { tone: 'info', label: 'High' },
  medium: { tone: 'warn', label: 'Medium' },
  low: { tone: 'bad', label: 'Low' },
};

const perWeek = (n) => (n == null ? '—' : n >= 10 ? Math.round(n).toString() : n.toFixed(1));

/**
 * Delivery to production (the four DORA measures) for the Insights page:
 * how often you deploy, commit-to-production time, how many deploys fail and
 * how long recovering from one takes. Production is what the production
 * monitors are linked to, plus release stages named like production.
 */
export default function Delivery({ days }) {
  const { openDrawer } = useApp();
  const projectLabel = useProjectLabel();
  const { data, error, reload } = useApi(`/delivery?days=${Math.min(90, days)}`);

  const head = (
    <>
      <p className="muted small delivery-intro">{t('The four DORA measures, from your production deploys: how often you ship, how long a change takes to reach users, how often a deploy fails, and how fast you recover.')}</p>
    </>
  );
  if (!data) return <section>{head}{error ? <ErrorBox error={error} onRetry={reload} /> : <Loading />}</section>;

  if (!data.targets.length) {
    return (
      <section>
        {head}
        <p className="callout">
          {t('No production environment found. Link a production monitor to the release stage or pipeline that deploys it, or name the classic release stage "Production".')}
          {' '}<Link to="/settings#production">{t('Settings → Production monitors')}</Link>
        </p>
      </section>
    );
  }

  const tot = data.totals;
  const facts = [
    [t('Deploys per week'), perWeek(tot.deploysPerWeek), data.bands.frequency, t(tot.deploys === 1 ? '{n} deploy in {days} days' : '{n} deploys in {days} days', { n: tot.deploys, days: data.days })],
    [t('Lead time for changes'), hours(tot.medianLeadTimeHours), data.bands.leadTime, t('median, from commit to production')],
    [t('Failed deploys'), pct(tot.failureRate), data.bands.failureRate, t('{n} failed', { n: tot.failed })],
    [t('Time to recover'), hours(tot.medianRecoveryHours), data.bands.recovery, t('median, from a failed deploy to the next good one')],
  ];

  return (
    <section className="delivery">
      {head}
      <dl className="fact-row">
        {facts.map(([k, v, b, note]) => (
          <div key={k} className="fact">
            <dt>{k}</dt>
            <dd>{v} {b && <Chip tone={BAND[b].tone} title={t('DORA performance band')}>{t(BAND[b].label)}</Chip>}</dd>
            <dd className="muted small">{note}</dd>
          </div>
        ))}
      </dl>
      <div className="chart-grid">
        <ColumnChart
          label={t('Production deploys per week')}
          valueLabel={t('deploys')}
          data={data.weekly.map((w) => ({ key: w.week, value: w.deploys, note: w.failed ? t('{n} failed', { n: w.failed }) : null }))}
          formatX={(k) => t('Wk of {date}', { date: date(k) })}
        />
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>{t('Environment')}</th>
              <th className="num">{t('Deploys')}</th>
              <th className="num">{t('Failed')}</th>
              <th className="num">{t('Lead time')}</th>
              <th className="num">{t('Recovery')}</th>
              <th>{t('Last deploy')}</th>
            </tr>
          </thead>
          <tbody>
            {data.targets.map((r) => {
              const last = r.lastDeploy;
              const status = last && (DEPLOY_STATUS[last.status] || { tone: 'muted', label: last.status });
              return (
                <tr key={`${r.org || ''}:${r.key}`}>
                  <td><span className="strong">{r.name}</span> <span className="muted small">{projectLabel(r.projectName, r.org)}</span></td>
                  <td className="num">{r.deploys}</td>
                  <td className={`num ${r.failureRate > 0.15 ? 'text-warn' : ''}`}>{r.failed ? `${r.failed} · ${pct(r.failureRate)}` : '0'}</td>
                  <td className="num">{hours(r.medianLeadTimeHours)}</td>
                  <td className="num">{hours(r.medianRecoveryHours)}{r.unrecovered ? <span className="text-bad small"> · {t('still failing')}</span> : null}</td>
                  <td>
                    {last ? (
                      <button type="button" className="link-btn" onClick={() => openDrawer({ type: 'deploy', projectId: r.key.split(':')[1], target: r.key, id: last.id, org: r.org })} title={t('What this deploy shipped')}>
                        {last.label}
                      </button>
                    ) : '—'}
                    {last && <span className="muted small"> · <Chip tone={status.tone}>{t(status.label)}</Chip> {t('{age} ago', { age: age(last.at) })}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
