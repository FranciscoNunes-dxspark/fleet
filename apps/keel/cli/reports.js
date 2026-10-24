// The reports the terminal app shows in its viewer, as plain text: insights (pull request flow and
// delivery to production), flaky tests, closed pull requests, recent commits and platform totals.
// Each reads what the web app's page of the same name reads from the service. Pure, so the tests
// can check it.
import { branch } from './format.js';
import { relTime } from './text.js';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const ago = (iso, now) => {
  if (!iso) return '';
  const r = relTime(Date.parse(iso), now);
  return r === 'now' ? 'just now' : `${r} ago`;
};
const pct = (x) => (x == null ? '–' : `${Math.round(x * 100)}%`);
/** 38.5 hours as "1.6d", 5.2 as "5h", 0.3 as "18m". */
export const dur = (h) => (h == null ? '–' : h >= 48 ? `${(h / 24).toFixed(1)}d` : h >= 1 ? `${Math.round(h)}h` : `${Math.round(h * 60)}m`);
const day = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

const BARS = '▁▂▃▄▅▆▇█';
/** A row of block characters, one per value, as tall as each is against the biggest. */
export function sparkline(values) {
  const max = Math.max(0, ...values);
  return values.map((v) => (max ? BARS[Math.min(BARS.length - 1, Math.round((v / max) * (BARS.length - 1)))] : BARS[0])).join('');
}

// The DORA bands, as the web app's Delivery card names them.
const BAND = { elite: 'elite', high: 'high', medium: 'medium', low: 'low' };

/** /insights: the web app's Insights page (pull request flow) and Delivery to production (the four DORA measures). */
export function insightsText(ins, del, now = Date.now()) {
  const out = [`The last ${ins?.days ?? del?.days ?? 30} days`];
  if (ins) {
    const t = ins.totals;
    out.push(
      '',
      'Pull requests',
      `  ${t.merged} merged · ${t.abandoned} abandoned · ${t.activePrs} open now`,
      `  Open to merged: half within ${dur(t.medianCycleHours)}, 85% within ${dur(t.p85CycleHours)}`,
      `  What's open has waited ${dur(t.medianOpenAgeHours)} (median) · builds green ${pct(t.buildPassRate)} of the time · ${plural(t.reviewersActive, 'reviewer')} active`,
    );
    if (ins.weekly?.length) out.push(`  Merged each week  ${sparkline(ins.weekly.map((w) => w.merged))}  ${ins.weekly.map((w) => `${day(w.week)} ${w.merged}`).join(' · ')}`);
    if (ins.openAge?.length) out.push(`  How long what's open has waited: ${ins.openAge.map((b) => `${b.label} ${b.count}`).join(' · ')}`);
    if (ins.byRepo?.length) {
      out.push('', '  By repository (merged · half within · 85% within)');
      for (const r of ins.byRepo) out.push(`    ${r.projectName} / ${r.repoName}: ${r.count} · ${dur(r.medianCycleHours)} · ${dur(r.p85CycleHours)}`);
    }
    if (ins.byAuthor?.length) {
      out.push('', '  By author (merged · half within)');
      for (const a of ins.byAuthor) out.push(`    ${a.person?.displayName ?? a.key}: ${a.count} · ${dur(a.medianCycleHours)}`);
    }
    if (ins.byReviewer?.length) out.push('', `  Reviews done: ${ins.byReviewer.map((r) => `${r.person?.displayName ?? r.key} ${r.count}`).join(' · ')}`);
  }
  if (del) {
    const t = del.totals;
    const band = (k) => (del.bands?.[k] ? `  (${BAND[del.bands[k]] ?? del.bands[k]})` : '');
    out.push(
      '',
      'Delivery to production',
      `  Deploys: ${t.deploys}, ${t.deploysPerWeek?.toFixed(1) ?? '–'} a week${band('frequency')}`,
      `  Lead time, merged to deployed: ${dur(t.medianLeadTimeHours)} (median)${band('leadTime')}`,
      `  Change failure rate: ${pct(t.failureRate)} (${t.failed} failed)${band('failureRate')}`,
      `  Time to restore: ${dur(t.medianRecoveryHours)} (median)${band('recovery')}`,
    );
    if (del.weekly?.length) out.push(`  Deploys each week  ${sparkline(del.weekly.map((w) => w.deploys))}  ${del.weekly.map((w) => `${day(w.week)} ${w.deploys}${w.failed ? ` (${w.failed} failed)` : ''}`).join(' · ')}`);
    if (del.targets?.length) {
      out.push('', '  By environment');
      for (const e of del.targets) {
        const last = e.lastDeploy ? ` · last ${e.lastDeploy.label} ${e.lastDeploy.status === 'succeeded' ? '✓' : '✗'} ${ago(e.lastDeploy.at, now)}` : '';
        out.push(`    ${e.name} (${e.projectName}): ${plural(e.deploys, 'deploy')}, ${e.failed} failed (${pct(e.failureRate)}) · lead ${dur(e.medianLeadTimeHours)} · restore ${dur(e.medianRecoveryHours)}${e.unrecovered ? ` · ${e.unrecovered} not recovered` : ''}${last}`);
      }
    }
  }
  return out.join('\n');
}

/** /flaky: tests that fail now and then on a pipeline's own branch and pass again without a fix. */
export function flakyText(f, now = Date.now()) {
  if (f.noTestData) return "No test results in the last runs: Keel finds flaky tests in the results pipelines publish (PublishTestResults, or the test task's own).";
  const out = [`${plural(f.tests.length, 'flaky test')} in the last ${f.days} days · ${plural(f.analyzed.runs, 'run')} of ${plural(f.analyzed.pipelines, 'pipeline')} read${f.analyzed.unreadable ? ` (${f.analyzed.unreadable} couldn't be)` : ''}`];
  if (!f.tests.length) out.push('', 'None: every test that failed stayed failed until it was fixed, or never failed.');
  for (const t of f.tests) {
    out.push(
      '',
      `${t.failingNow ? '✗ failing now' : '◐ passing now'}  ${t.shortName ?? t.name}`,
      `  ${t.pipeline.name} (${t.pipeline.projectName}) on ${branch(t.pipeline.branch)} · failed ${t.fails} of ${t.runs} runs (${pct(t.failRate)}) · flipped ${t.flips} times${t.sameCommit ? ' · passed again on the same commit' : ''}`,
      `  Last failed ${ago(t.lastFailedAt, now)}${t.lastFailedRun ? ` in ${t.lastFailedRun.buildNumber}` : ''}`,
    );
    if (t.error) out.push(`  ${String(t.error).split('\n')[0]}`);
    if (t.lastFailedRun?.webUrl) out.push(`  ${t.lastFailedRun.webUrl}`);
  }
  return out.join('\n');
}

const VOTE = { 10: '✓', 5: '✓', 0: '·', '-5': '‖', '-10': '✗' };

/** /closed: pull requests completed or abandoned lately, newest first. */
export function closedText(c, now = Date.now()) {
  const prs = [...(c.prs ?? [])].sort((a, b) => Date.parse(b.closedAt) - Date.parse(a.closedAt));
  const merged = prs.filter((p) => p.status === 'completed').length;
  const out = [`${plural(prs.length, 'pull request')} closed in the last ${c.days} days: ${merged} completed, ${prs.length - merged} abandoned`];
  for (const p of prs) {
    const open = (Date.parse(p.closedAt) - Date.parse(p.createdAt)) / 3_600_000;
    const votes = (p.reviewers ?? []).filter((r) => !r.isContainer).map((r) => `${VOTE[r.vote] ?? '·'} ${r.displayName}`).join(', ');
    out.push(
      '',
      `${p.status === 'completed' ? '✓' : '⊘'} !${p.id} ${p.title}`,
      `  ${p.projectName} / ${p.repoName} · ${branch(p.sourceBranch)} → ${branch(p.targetBranch)} · by ${p.author?.displayName ?? 'someone'}`,
      `  ${p.status === 'completed' ? 'Completed' : 'Abandoned'} ${ago(p.closedAt, now)}${p.closedBy?.displayName ? ` by ${p.closedBy.displayName}` : ''} · open ${dur(open)}${votes ? ` · ${votes}` : ''}`,
    );
  }
  return out.join('\n');
}

/** /commits: the default branch's commits in every tracked repo (or one repo), newest first, by day. */
export function commitsText(c, now = Date.now()) {
  const commits = c.commits ?? [];
  const out = [`${plural(commits.length, 'commit')} in the last ${plural(c.days, 'day')}${c.branch ? ` on ${branch(c.branch)}` : ', on each repo\'s default branch'}`];
  if (c.failed?.length) out.push(`  Couldn't read ${c.failed.map((f) => f.repoName ?? f).join(', ')}`);
  let last = '';
  for (const x of commits) {
    const d = new Date(x.committedAt).toDateString();
    if (d !== last) {
      out.push('', new Date(x.committedAt).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }));
      last = d;
    }
    const refs = [x.prId ? `!${x.prId}` : '', ...(x.workItemIds ?? []).map((id) => `#${id}`)].filter(Boolean).join(' ');
    out.push(`  ${x.id.slice(0, 7)} ${x.subject ?? String(x.message ?? '').split('\n')[0]}`, `          ${x.repoName} · ${x.author?.name ?? 'someone'} · ${ago(x.committedAt, now)}${refs ? ` · ${refs}` : ''}`);
  }
  return out.join('\n');
}

// Names for the figures come from the server's catalogue (data/platform-labels.json); the rest read as words.
const humanize = (id) => id.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().replace(/^./, (ch) => ch.toUpperCase());
export const figureLabel = (type, catalogue) => catalogue?.types?.[type] ?? catalogue?.areas?.[type] ?? humanize(type);

/** /totals: each site's platform totals (the /totals envelope), the key figures first, with the change since the fetch before. */
export function totalsText(sites, now = Date.now(), catalogue = null) {
  const KEY_FIGURES = catalogue?.keyFigures ?? [];
  const label = (type) => figureLabel(type, catalogue);
  if (!sites?.length) return 'No sites report platform totals yet. Production monitors with a totals key get them (Settings → Production monitors, on the web).';
  const out = [];
  for (const s of sites) {
    const l = s.latest;
    out.push(`${s.name}`);
    const where = l ? [l.product, l.site, l.version && `v${l.version}`, l.season?.name && `season ${l.season.name}`].filter(Boolean).join(' · ') : '';
    out.push(`  ${where}${where ? ' · ' : ''}${l ? `fetched ${ago(l.at, now)}` : 'not fetched yet'}${s.nextAt && Date.parse(s.nextAt) > now ? ` · the next in ${relTime(now - (Date.parse(s.nextAt) - now), now)}` : ''}`);
    if (s.lastError) out.push(`  ✗ The last fetch failed: ${s.lastError}`);
    if (l?.failing?.length) out.push(`  ✗ Couldn't count: ${l.failing.map((f) => (typeof f === 'string' ? label(f) : `${label(String(f.type ?? f.name ?? '?'))}${f.error ? ` (${f.error})` : ''}`)).join(', ')}`);
    if (!l?.totals?.length) {
      out.push('');
      continue;
    }
    const before = s.previous?.seasonId === l.season?.id ? s.previous.values : null;
    const fig = (t) => {
      const was = before?.[t.type];
      const change = was != null && t.total !== was ? ` (${t.total > was ? '+' : ''}${t.total - was})` : '';
      return `${label(t.type)} ${t.total.toLocaleString('en-GB')}${change}`;
    };
    const key = KEY_FIGURES.map((k) => l.totals.find((t) => t.type === k)).filter(Boolean);
    if (key.length) out.push(`  ${key.map(fig).join(' · ')}`);
    const rest = l.totals.filter((t) => !KEY_FIGURES.includes(t.type));
    const areas = new Map();
    for (const t of rest) {
      const a = t.areas?.[0] ?? 'other';
      if (!areas.has(a)) areas.set(a, []);
      areas.get(a).push(t);
    }
    for (const [a, list] of areas) out.push(`  ${label(a)}: ${list.map(fig).join(' · ')}`);
    out.push('');
  }
  return out.join('\n').trimEnd();
}
