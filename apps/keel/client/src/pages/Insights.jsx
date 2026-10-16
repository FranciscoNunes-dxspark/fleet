import { useSticky } from '../sticky.js';
import { BarList, ColumnChart } from '../charts.jsx';
import { useApi } from '../context.js';
import { date, hours, pct } from '../format.js';
import { ErrorBox, Loading, PageHeader } from '../ui.jsx';

const RANGES = [14, 30, 90];

export default function Insights() {
  const [days, setDays] = useSticky('insights.days', 30);
  const { data, error, reload, loading } = useApi(`/insights?days=${days}`);

  const header = (
    <PageHeader title="Insights" sub="How work flows through review and delivery across your tracked repos.">
      {loading && data && <span className="spinner" aria-label="Refreshing" />}
      <div className="segmented segmented-compact" role="tablist" aria-label="Time range">
        {RANGES.map((d) => <button key={d} type="button" role="tab" aria-selected={days === d} className={days === d ? 'on' : ''} onClick={() => setDays(d)}>{d} days</button>)}
      </div>
    </PageHeader>
  );
  if (!data) return <div className="page">{header}{error ? <ErrorBox error={error} onRetry={reload} /> : <Loading />}</div>;

  const t = data.totals;
  const facts = [
    ['Merged', t.merged, `${t.abandoned} abandoned`],
    ['Median time to merge', hours(t.medianCycleHours), `85th percentile ${hours(t.p85CycleHours)}`],
    ['Open right now', t.activePrs, `median age ${hours(t.medianOpenAgeHours)}`],
    ['Default-branch pass rate', pct(t.buildPassRate), 'all tracked pipelines'],
  ];
  const topReviewerShare = data.byReviewer.length && data.byReviewer[0].count / data.byReviewer.reduce((s, r) => s + r.count, 0);

  return (
    <div className="page">
      {header}
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
          label="Pull requests merged per week"
          valueLabel="merged"
          data={data.weekly.map((w) => ({ key: w.week, value: w.merged, note: w.medianCycleHours != null ? `median ${hours(w.medianCycleHours)} to merge` : null }))}
          formatX={(k) => `Wk of ${date(k)}`}
        />
        <BarList
          label="Age of open pull requests"
          valueLabel="PRs"
          data={data.openAge.map((b) => ({ key: b.label, label: b.label, value: b.count }))}
        />
        <BarList
          label="Approvals given (review load)"
          valueLabel="approvals"
          data={data.byReviewer.slice(0, 10).map((r) => ({ key: r.key, label: r.person.displayName, value: r.count }))}
        />
        <BarList
          label="Merged by author"
          valueLabel="merged"
          data={data.byAuthor.slice(0, 10).map((r) => ({ key: r.key, label: r.person?.displayName || 'Unknown', value: r.count, note: `median ${hours(r.medianCycleHours)}` }))}
        />
      </div>
      {topReviewerShare > 0.35 && (
        <p className="callout">
          {data.byReviewer[0].person.displayName} gave {Math.round(topReviewerShare * 100)}% of all approvals in this period. Spreading reviews wider lowers the bus factor and the queue.
        </p>
      )}

      <h2 className="section-title">By repository</h2>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Repository</th><th className="num">Merged</th><th className="num">Median to merge</th><th className="num">85th percentile</th></tr></thead>
          <tbody>
            {data.byRepo.map((r) => (
              <tr key={r.key}>
                <td><span className="strong">{r.repoName}</span> <span className="muted small">{r.projectName}</span></td>
                <td className="num">{r.count}</td>
                <td className="num">{hours(r.medianCycleHours)}</td>
                <td className={`num ${r.p85CycleHours > 120 ? 'text-warn' : ''}`}>{hours(r.p85CycleHours)}</td>
              </tr>
            ))}
            {!data.byRepo.length && <tr><td colSpan={4} className="muted">No merged pull requests in this range.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
