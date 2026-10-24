// Azure Monitor's metrics for an app or slot (Microsoft.Insights/metrics on the site): CPU time,
// memory, server errors and response time over the time span, drawn as sparklines beside the app in
// Resources; for a container app, its requests, CPU, memory and replicas. Pure: the ARM call is the
// provider's (azure/arm.js `metrics`, demo.js too).
import { sparklines } from './insights.js';

/** The metrics shown, in order: ARM's name, the aggregation asked for, and how a value reads. */
export const METRICS = [
  { name: 'CpuTime', label: 'cpu', aggregation: 'total', sum: true, format: (v) => `${seconds(v)} cpu` },
  { name: 'MemoryWorkingSet', label: 'memory', aggregation: 'average', format: (v) => bytes(v) },
  { name: 'Http5xx', label: '5xx', aggregation: 'total', sum: true, format: (v) => `${Math.round(v)} error${Math.round(v) === 1 ? '' : 's'}` },
  { name: 'HttpResponseTime', label: 'response', aggregation: 'average', format: (v) => `${Math.round(v * 1000)} ms` },
];

/** A container app's (Microsoft.App/containerApps): requests, CPU in cores, memory, replicas. */
export const CONTAINER_METRICS = [
  { name: 'Requests', label: 'requests', aggregation: 'total', sum: true, format: (v) => `${Math.round(v)} request${Math.round(v) === 1 ? '' : 's'}` },
  { name: 'UsageNanoCores', label: 'cpu', aggregation: 'average', format: (v) => cores(v) },
  { name: 'WorkingSetBytes', label: 'memory', aggregation: 'average', format: (v) => bytes(v) },
  { name: 'Replicas', label: 'replicas', aggregation: 'maximum', format: (v) => `${Math.round(v)}` },
];

/** The metrics shown for a target: a container app's, else a web app's. */
export const metricsFor = (target) => (target?.type === 'container' ? CONTAINER_METRICS : METRICS);

const cores = (v) => (v >= 1e9 ? `${(v / 1e9).toFixed(2)} cores` : `${Math.round(v / 1e6)} millicores`);
const seconds = (v) => (v >= 3600 ? `${(v / 3600).toFixed(1)} h` : v >= 60 ? `${(v / 60).toFixed(1)} min` : `${v >= 10 ? Math.round(v) : v.toFixed(1)} s`);
const bytes = (v) => (v >= 1024 ** 3 ? `${(v / 1024 ** 3).toFixed(1)} GB` : `${Math.round(v / 1024 ** 2)} MB`);

/** The grain for a span: 5 minutes over an hour, an hour over a day, 6 hours over a week, a day over 30. */
export function metricInterval(span) {
  if (span.hours <= 1) return 'PT5M';
  if (span.hours <= 24) return 'PT1H';
  if (span.hours <= 24 * 7) return 'PT6H';
  return 'P1D';
}

/** The metrics API's path and query for `target` over `span`, ending at `now`. */
export function metricsPath(target, span, now = Date.now(), defs = metricsFor(target)) {
  const from = new Date(now - span.hours * 60 * 60 * 1000).toISOString();
  const to = new Date(now).toISOString();
  const q = new URLSearchParams({
    'api-version': '2023-10-01',
    metricnames: defs.map((m) => m.name).join(','),
    timespan: `${from}/${to}`,
    interval: metricInterval(span),
    aggregation: defs.some((m) => m.aggregation === 'maximum') ? 'Total,Average,Maximum' : 'Total,Average',
  });
  return `${target.id}/providers/Microsoft.Insights/metrics?${q}`;
}

/** ARM's answer as [{ name, unit, points: [{ at, value }] }], each value the metric's own aggregation. */
export function seriesFrom(body, defs = METRICS) {
  return (body?.value ?? []).map((m) => {
    const def = defs.find((d) => d.name === m.name?.value);
    const data = (m.timeseries ?? []).flatMap((t) => t.data ?? []);
    return {
      name: m.name?.value,
      unit: m.unit,
      points: data.map((d) => ({ at: d.timeStamp, value: d[def?.aggregation ?? 'average'] ?? null })),
    };
  });
}

/**
 * The lines the details show: { label, spark, summary } per metric, the sparkline as wide as `width`
 * (the newest on the right), the summary a total over the span or the latest value and the highest.
 */
export function metricRows(series, { width = 24, defs = METRICS } = {}) {
  return defs.map((def) => {
    const s = series.find((x) => x.name === def.name);
    const values = (s?.points ?? []).filter((p) => p.value != null);
    if (!values.length) return { label: def.label, spark: '', summary: 'no data' };
    const spark = sparklines(values.map((p) => ({ problemId: def.name, bucket: p.at, n: p.value })), { width })[def.name] ?? '';
    const nums = values.map((p) => p.value);
    const summary = def.sum ? def.format(nums.reduce((a, b) => a + b, 0)) : `${def.format(nums.at(-1))} · peak ${def.format(Math.max(...nums))}`;
    return { label: def.label, spark, summary };
  });
}
