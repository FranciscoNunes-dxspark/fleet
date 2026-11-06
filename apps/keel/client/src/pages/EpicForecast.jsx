import { useMemo, useState } from 'react';
import { Button } from '@radix-ui/themes';
import { claudeScale, forecast, paceScale, remainingUnder, MIN_FINISHED } from '../forecast.js';
import { formatDate } from '../format.js';
import { Checkbox, Chip, Select, TypeLabel } from '../ui.jsx';
import { t } from '../i18n.js';

// How many runs each forecast simulates: enough that the dates hold still, quick enough to
// rerun on every what-if.
const RUNS = 2000;
const SHARES = [1, 0.75, 0.5, 0.25];
const ADDED = [0, 1, 2, 3];
// Claude Code: the share of the items left it takes on, and how much faster those go.
const CLAUDE_SHARES = [0, 0.25, 0.5, 0.75, 1];
const CLAUDE_SPEEDS = [1.5, 2, 3, 5];

const dayDate = (iso) => formatDate(`${iso}T12:00:00Z`, { day: 'numeric', month: 'short', year: 'numeric' });
// The row's short form: the year only when it isn't this one.
const shortDate = (iso) => formatDate(`${iso}T12:00:00Z`, iso.slice(0, 4) === String(new Date().getFullYear()) ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' });

/** The work left under an epic or feature and its forecast at the project's own pace. Seeded by the item, so it holds still. */
export function useForecast(node, pace) {
  const left = useMemo(() => remainingUnder(node), [node]);
  const f = useMemo(() => (pace ? forecast({ remaining: left.length, daily: pace.daily, seed: node.item.id, runs: RUNS }) : null), [left, pace, node.item.id]);
  return { left, f };
}

/** The row's chip: the 85% date, or a plain "No forecast" that opens the panel to say why. */
export function ForecastChip({ f, open, onToggle }) {
  if (!f || f.reason === 'nothing-left') return null;
  const p85 = f.ok ? f.odds.find((o) => o.p === 85) : null;
  const label = p85 ? t('85%: {date}', { date: shortDate(p85.date) }) : t('No forecast');
  return (
    <button type="button" className={`forecast-chip ${p85 ? '' : 'muted'}`} aria-expanded={open} onClick={onToggle}
      title={p85 ? t('85% likely to be done by {date}. Open it for the odds and a what-if.', { date: dayDate(p85.date) }) : t('Why there is no forecast')}>
      {label}
    </button>
  );
}

/** Why a forecast can't be made, in a sentence. */
function reasonText(f, pace, project) {
  if (f.reason === 'too-little-history') {
    return t('Not enough history to forecast: {project} finished {n} backlog items in the last {days} days, and a forecast needs at least {min}.', { project, n: pace.finished, days: pace.days, min: MIN_FINISHED });
  }
  if (f.reason === 'too-slow') return t('At this pace some runs never finish: there is far more work left than the team has been finishing.');
  return t('Nothing left to forecast: every remaining item is left out.');
}

/**
 * The forecast in full under its row: the three dates and what they mean, and a what-if (leave
 * items out, a share of the team's pace, people added, Claude Code taking on some of the items)
 * that reruns it as you change it.
 */
export function ForecastPanel({ node, left, pace, project }) {
  const [excluded, setExcluded] = useState(() => new Set());
  const [share, setShare] = useState(1);
  const [added, setAdded] = useState(0);
  const [claudeShare, setClaudeShare] = useState(0);
  const [claudeSpeed, setClaudeSpeed] = useState(2);
  const scale = paceScale({ share, added, people: pace.people }) * claudeScale({ share: claudeShare, speed: claudeSpeed });
  const remaining = left.filter((w) => !excluded.has(w.id)).length;
  const f = useMemo(() => forecast({ remaining, daily: pace.daily, seed: node.item.id, runs: RUNS, scale }), [remaining, pace, node.item.id, scale]);
  const changed = excluded.size > 0 || share !== 1 || added !== 0 || claudeShare !== 0;
  const toggle = (id) => setExcluded((s) => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  return (
    <div className="forecast-panel">
      <div className="forecast-head">
        <strong>{t('When will this land?')}</strong>
        <span className="muted small">{t(remaining === 1 ? '{n} item left' : '{n} items left', { n: remaining })}</span>
        {changed && <Chip tone="info">{t('What-if')}</Chip>}
      </div>
      {f.ok ? (
        <ul className="forecast-odds">
          {f.odds.map((o) => (
            <li key={o.p} className={o.p === 85 ? 'forecast-main' : ''}>
              <span className="forecast-p">{o.p}%</span>
              <strong>{dayDate(o.date)}</strong>
              <span className="muted small">{t(o.days === 1 ? 'in {n} day' : 'in {n} days', { n: o.days })}</span>
            </li>
          ))}
        </ul>
      ) : <p className="forecast-none">{reasonText(f, pace, project)}</p>}
      <p className="muted small">
        {t('{runs} simulated runs, each drawing days at random from the last {days} days of {project}: {n} backlog items finished, by {people} people. Half the runs were done by the 50% date, 85 in 100 by the 85% date and 95 in 100 by the 95% date.', { runs: RUNS.toLocaleString(), days: pace.days, project, n: pace.finished, people: pace.people })}
        {' '}{t('It assumes the whole project\'s pace goes to this work; if the team works on other things too, give it a share below.')}
      </p>
      <div className="forecast-whatif">
        <label className="field-inline">
          <span className="small">{t('Share of the team\'s pace')}</span>
          <Select className="input" value={String(share)} onChange={(e) => setShare(Number(e.target.value))} aria-label={t('Share of the team\'s pace')}>
            {SHARES.map((s) => <option key={s} value={String(s)}>{`${Math.round(s * 100)}%`}</option>)}
          </Select>
        </label>
        <label className="field-inline">
          <span className="small">{t('People added')}</span>
          <Select className="input" value={String(added)} onChange={(e) => setAdded(Number(e.target.value))} aria-label={t('People added')}>
            {ADDED.map((n) => <option key={n} value={String(n)}>{n === 0 ? t('None') : t(n === 1 ? '+{n} person' : '+{n} people', { n })}</option>)}
          </Select>
        </label>
        <label className="field-inline">
          <span className="small">{t('Claude Code takes on')}</span>
          <Select className="input" value={String(claudeShare)} onChange={(e) => setClaudeShare(Number(e.target.value))} aria-label={t('Claude Code takes on')}>
            {CLAUDE_SHARES.map((s) => <option key={s} value={String(s)}>{s === 0 ? t('Nothing more') : s === 1 ? t('Every item') : t('{n}% of the items', { n: Math.round(s * 100) })}</option>)}
          </Select>
        </label>
        {claudeShare > 0 && (
          <label className="field-inline">
            <span className="small">{t('Those go')}</span>
            <Select className="input" value={String(claudeSpeed)} onChange={(e) => setClaudeSpeed(Number(e.target.value))} aria-label={t('How much faster the items Claude Code takes on go')}>
              {CLAUDE_SPEEDS.map((v) => <option key={v} value={String(v)}>{t('{n}× faster', { n: v })}</option>)}
            </Select>
          </label>
        )}
        {changed && <Button size="1" variant="ghost" color="gray" type="button" onClick={() => { setExcluded(new Set()); setShare(1); setAdded(0); setClaudeShare(0); setClaudeSpeed(2); }}>{t('Reset')}</Button>}
      </div>
      {claudeShare > 0 && (
        <p className="muted small">
          {t('With Claude Code taking on {share}% of the items at {speed}× the pace, the work goes {gain}% faster overall: the rest still takes the team\'s time. It\'s your estimate, not a measure, and if the team already works with Claude Code, its past pace includes it: count only what it would take on beyond that.', {
            share: Math.round(claudeShare * 100), speed: claudeSpeed, gain: Math.round((claudeScale({ share: claudeShare, speed: claudeSpeed }) - 1) * 100),
          })}
        </p>
      )}
      {left.length > 0 && (
        <details className="forecast-items">
          <summary className="small">{t('Leave items out ({n} of {total})', { n: excluded.size, total: left.length })}</summary>
          <ul>
            {left.map((w) => (
              <li key={w.id}>
                <label className="check">
                  <Checkbox checked={excluded.has(w.id)} onChange={() => toggle(w.id)} aria-label={t('Leave out {title}', { title: w.title })} />
                  <TypeLabel type={w.type} color={w.typeColor} />
                  <span className={excluded.has(w.id) ? 'muted forecast-out' : ''}>{w.title}</span>
                  <span className="mono muted small">{w.id}</span>
                </label>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
