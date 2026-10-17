import { useSticky, useStickyParams } from '../sticky.js';
import { BarList, ColumnChart } from '../charts.jsx';
import { useApi } from '../context.js';
import { date, hours, pct } from '../format.js';
import { ErrorBox, Loading, PageHeader } from '../ui.jsx';
import { t, tx } from '../i18n.js';
import Delivery from './Delivery.jsx';

const RANGES = [14, 30, 90];

/** Two tabs over the same period: delivery to production (DORA) and code review and merging. */
export default function Insights() {
  const [days, setDays] = useSticky('insights.days', 30);
  const [params, setParams] = useStickyParams('insights', ['tab']);
  const tab = params.get('tab') === 'review' ? 'review' : 'delivery';

  return (
    <div className="page page-wide">
      <PageHeader title={t('Insights')} sub={t('How work flows through review and delivery across your tracked repos.')}>
        <div className="segmented segmented-compact" role="tablist" aria-label={t('Time range')}>
          {RANGES.map((d) => <button key={d} type="button" role="tab" aria-selected={days === d} className={days === d ? 'on' : ''} onClick={() => setDays(d)}>{t('{n} days', { n: d })}</button>)}
        </div>
      </PageHeader>
      <div className="segmented" role="tablist" aria-label={t('Insights')}>
        <button type="button" role="tab" aria-selected={tab === 'delivery'} className={tab === 'delivery' ? 'on' : ''} onClick={() => setParams({}, { replace: true })}>{t('Delivery to production')}</button>
        <button type="button" role="tab" aria-selected={tab === 'review'} className={tab === 'review' ? 'on' : ''} onClick={() => setParams({ tab: 'review' }, { replace: true })}>{t('Code review and merging')}</button>
      </div>
      {tab === 'delivery' ? <Delivery days={days} /> : <ReviewInsights days={days} />}
    </div>
  );
}

function ReviewInsights({ days }) {
  const { data, error, reload, loading } = useApi(`/insights?days=${days}`);
  if (!data) return error ? <ErrorBox error={error} onRetry={reload} /> : <Loading />;

  const tot = data.totals;
  const facts = [
    [t('Merged'), tot.merged, t('{n} abandoned', { n: tot.abandoned })],
    [t('Median time to merge'), hours(tot.medianCycleHours), t('85th percentile {time}', { time: hours(tot.p85CycleHours) })],
    [t('Open right now'), tot.activePrs, t('median age {time}', { time: hours(tot.medianOpenAgeHours) })],
    [t('Default-branch pass rate'), pct(tot.buildPassRate), t('all tracked pipelines')],
  ];
  const topReviewerShare = data.byReviewer.length && data.byReviewer[0].count / data.byReviewer.reduce((s, r) => s + r.count, 0);

  return (
    <section aria-busy={loading}>
      <dl className="fact-row">
        {facts.map(([k, v, note]) => (
          <div key={k} className="fact">
            <dt>{k}</dt>
            <dd>{v}</dd>
            <dd className="muted small">{note}</dd>
          </div>
        ))}
      </dl>

      <div className="chart-grid">
        <ColumnChart
          label={t('Pull requests merged per week')}
          valueLabel={t('merged')}
          data={data.weekly.map((w) => ({ key: w.week, value: w.merged, note: w.medianCycleHours != null ? t('median {time} to merge', { time: hours(w.medianCycleHours) }) : null }))}
          formatX={(k) => t('Wk of {date}', { date: date(k) })}
        />
        <BarList
          label={t('Age of open pull requests')}
          valueLabel={t('PRs')}
          data={data.openAge.map((b) => ({ key: b.label, label: tx(b.label), value: b.count }))}
        />
        <BarList
          label={t('Approvals given (review load)')}
          valueLabel={t('approvals')}
          data={data.byReviewer.slice(0, 10).map((r) => ({ key: r.key, label: r.person.displayName, value: r.count }))}
        />
        <BarList
          label={t('Merged by author')}
          valueLabel={t('merged')}
          data={data.byAuthor.slice(0, 10).map((r) => ({ key: r.key, label: r.person?.displayName || t('Unknown'), value: r.count, note: t('median {time}', { time: hours(r.medianCycleHours) }) }))}
        />
      </div>
      {topReviewerShare > 0.35 && (
        <p className="callout">
          {t('{name} gave {pct}% of all approvals in this period. Spreading reviews wider lowers the bus factor and the queue.', { name: data.byReviewer[0].person.displayName, pct: Math.round(topReviewerShare * 100) })}
        </p>
      )}

      <h2 className="section-title">{t('By repository')}</h2>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>{t('Repository')}</th><th className="num">{t('Merged')}</th><th className="num">{t('Median to merge')}</th><th className="num">{t('85th percentile')}</th></tr></thead>
          <tbody>
            {data.byRepo.map((r) => (
              <tr key={r.key}>
                <td><span className="strong">{r.repoName}</span> <span className="muted small">{r.projectName}</span></td>
                <td className="num">{r.count}</td>
                <td className="num">{hours(r.medianCycleHours)}</td>
                <td className={`num ${r.p85CycleHours > 120 ? 'text-warn' : ''}`}>{hours(r.p85CycleHours)}</td>
              </tr>
            ))}
            {!data.byRepo.length && <tr><td colSpan={4} className="muted">{t('No merged pull requests in this range.')}</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
