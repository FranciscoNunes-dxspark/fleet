import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi, useApp } from '../context.js';
import { age, hours, pct, REVIEW_STATE } from '../format.js';
import { Avatar, Chip, ErrorBox, PageHeader } from '../ui.jsx';
import { PREF_KEYS, pushPref } from '../prefs.js';
import { locale, t, tj, tx } from '../i18n.js';

// WIDGETS title / linkText stay English here; they are translated with t() at render
// so they follow the current language.

const WIDGETS = [
  { id: 'production', title: 'Production', link: '/production', linkText: 'Details' },
  { id: 'attention', title: 'Needs you', link: '/inbox', linkText: 'Open inbox' },
  { id: 'reviews', title: 'Your review queue', link: '/prs', linkText: 'All pull requests' },
  { id: 'pipelines', title: 'Pipelines', link: '/pipelines', linkText: 'All pipelines' },
  { id: 'work', title: 'Work in progress', link: '/work', linkText: 'All work items' },
  { id: 'team', title: 'Team load', link: '/team', linkText: 'Team' },
  { id: 'flow', title: 'Delivery, last 14 days', link: '/insights', linkText: 'Insights' },
  { id: 'epics', title: 'Epic progress', link: '/epics', linkText: 'All epics' },
  { id: 'mine', title: 'My work', link: '/work?view=mine', linkText: 'My items' },
];
// Keel writes the titles of these kinds; the others (pull requests, work items) carry the
// Azure DevOps title, shown as is so templates can't rewrite e.g. a PR titled "Site is down".
const KEEL_TITLES = ['production', 'approval', 'pipeline', 'team'];
const itemTitle = (i) => (KEEL_TITLES.includes(i.kind) ? tx(i.title) : i.title);
const DEFAULT_LAYOUT = WIDGETS.map((w) => ({ id: w.id, visible: w.id !== 'mine' }));
const STORAGE_KEY = PREF_KEYS.dashboard;
const LEGACY_KEY = 'leadConsole.dashboard.v1'; // before the rename to Shipdeck

function loadLayout() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_KEY) || 'null');
    if (!Array.isArray(saved)) return DEFAULT_LAYOUT;
    const known = saved.filter((s) => WIDGETS.some((w) => w.id === s.id));
    // Widgets added in later versions show up at the end.
    return [...known, ...DEFAULT_LAYOUT.filter((d) => !known.some((k) => k.id === d.id))];
  } catch {
    return DEFAULT_LAYOUT;
  }
}

function saveLayout(layout) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // Storage unavailable (private mode): layout lasts for this visit only.
  }
  pushPref('dashboard', layout); // follows your account to other devices
}

export default function Dashboard() {
  const { meta } = useApp();
  const [layout, setLayout] = useState(loadLayout);
  const [editing, setEditing] = useState(false);

  const update = (next) => {
    setLayout(next);
    saveLayout(next);
  };
  const move = (i, dir) => {
    const next = [...layout];
    const j = i + dir;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    update(next);
  };
  const setVisible = (id, visible) => update(layout.map((l) => (l.id === id ? { ...l, visible } : l)));

  const hour = new Date().getHours();
  const first = meta.me.displayName.replace(/\(.*?\)/, '').trim().split(/\s+/)[0];
  const greeting = t(hour < 12 ? 'Good morning, {name}' : hour < 18 ? 'Good afternoon, {name}' : 'Good evening, {name}', { name: first });
  const shown = layout.filter((l) => l.visible);
  const hidden = layout.filter((l) => !l.visible);

  return (
    <div className="page page-wide">
      <PageHeader title={greeting} sub={meta.trackedProjects.map((p) => p.name).join(', ') || t('No projects tracked yet')}>
        <button type="button" className={`btn btn-small ${editing ? 'btn-primary' : ''}`} onClick={() => setEditing((e) => !e)}>
          {editing ? t('Done') : t('Customize')}
        </button>
      </PageHeader>

      {editing && (
        <div className="panel customize">
          <p className="small muted">{t("Use the arrows on each widget to reorder it, or hide what you don't need. Your layout is saved in this browser.")}</p>
          {hidden.length > 0 && (
            <div className="chips">
              <span className="small">{t('Hidden:')}</span>
              {hidden.map((h) => (
                <button key={h.id} type="button" className="toggle" onClick={() => setVisible(h.id, true)}>+ {t(WIDGETS.find((w) => w.id === h.id).title)}</button>
              ))}
            </div>
          )}
          <button type="button" className="btn btn-ghost btn-small" onClick={() => update(DEFAULT_LAYOUT)}>{t('Reset to default')}</button>
        </div>
      )}

      <div className="widget-grid">
        {shown.map((l) => {
          const def = WIDGETS.find((w) => w.id === l.id);
          const i = layout.findIndex((x) => x.id === l.id);
          const title = t(def.title);
          return (
            <section key={l.id} className={`widget widget-${l.id}`} aria-label={title}>
              <header className="widget-head">
                <h2>{title}</h2>
                {editing ? (
                  <span className="widget-edit">
                    <button type="button" className="btn btn-ghost btn-small" onClick={() => move(i, -1)} aria-label={t('Move {widget} earlier', { widget: title })}>↑</button>
                    <button type="button" className="btn btn-ghost btn-small" onClick={() => move(i, 1)} aria-label={t('Move {widget} later', { widget: title })}>↓</button>
                    <button type="button" className="btn btn-ghost btn-small" onClick={() => setVisible(l.id, false)}>{t('Hide')}</button>
                  </span>
                ) : <Link to={def.link} className="small">{t(def.linkText)}</Link>}
              </header>
              <WidgetBody id={l.id} />
            </section>
          );
        })}
      </div>
    </div>
  );
}

function WidgetBody({ id }) {
  switch (id) {
    case 'production': return <ProductionWidget />;
    case 'attention': return <AttentionWidget />;
    case 'reviews': return <ReviewsWidget />;
    case 'pipelines': return <PipelinesWidget />;
    case 'work': return <WorkWidget />;
    case 'team': return <TeamWidget />;
    case 'flow': return <FlowWidget />;
    case 'epics': return <EpicsWidget />;
    case 'mine': return <MineWidget />;
    default: return null;
  }
}

function useWidgetData(path) {
  const r = useApi(path);
  const fallback = r.error ? <ErrorBox error={r.error} onRetry={r.reload} /> : <div className="widget-loading" aria-label={t('Loading')}><span className="spinner" /></div>;
  return { data: r.data, fallback: r.data ? null : fallback };
}

/** Big number with a label; `to` makes it a link into the filtered view. */
function Stat({ value, label, tone, to }) {
  const body = <><span className={`stat-value ${tone ? `text-${tone}` : ''}`}>{value}</span><span className="stat-label">{label}</span></>;
  return to ? <Link to={to} className="stat">{body}</Link> : <span className="stat">{body}</span>;
}

function AttentionWidget() {
  const { data, fallback } = useWidgetData('/attention');
  const { openDrawer } = useApp();
  if (fallback) return fallback;
  const s = data.summary;
  const top = data.items.slice(0, 6);
  return (
    <>
      <div className="stat-row">
        <Stat value={s.high} label={t('act now')} tone={s.high ? 'bad' : undefined} to="/inbox" />
        <Stat value={s.myReviews} label={t('reviews for you')} to="/prs" />
        {s.approvals > 0 && <Stat value={s.approvals} label={t('approvals')} tone="accent" to="/pipelines" />}
        <Stat value={s.blockedItems} label={t('blocked')} tone={s.blockedItems ? 'warn' : undefined} to="/work?view=blocked" />
      </div>
      {top.length ? (
        <ul className="mini-list">
          {top.map((i) => (
            <li key={i.key} className={`mini-sev sev-${i.severity}`}>
              {i.target.type === 'pr' || i.target.type === 'workitem'
                ? <button type="button" className="link-btn mini-title" onClick={() => openDrawer(i.target)}>{itemTitle(i)}</button>
                : <Link className="mini-title" to={i.target.type === 'person' ? '/team' : i.target.type === 'release' ? '/pipelines?tab=releases' : i.target.type === 'production' ? '/production' : '/pipelines'}>{itemTitle(i)}</Link>}
              <span className="muted small truncate">{tx(i.reasons[0].text)}</span>
            </li>
          ))}
        </ul>
      ) : <p className="muted small">{t('Nothing needs you right now.')}</p>}
    </>
  );
}

function ReviewsWidget() {
  const { data, fallback } = useWidgetData('/prs');
  const { openDrawer, meta } = useApp();
  if (fallback) return fallback;
  const mine = data.prs.filter((p) => p.needsMyReview).sort((a, b) => b.ageHours - a.ageHours);
  const stale = data.prs.filter((p) => !p.isDraft && p.ageHours >= meta.thresholds.stalePrDays * 24).length;
  return (
    <>
      <div className="stat-row">
        <Stat value={mine.length} label={t('waiting on you')} tone={mine.length ? 'accent' : undefined} to="/prs" />
        <Stat value={data.prs.length} label={t('open PRs')} to="/prs" />
        <Stat value={stale} label={t('stale')} tone={stale ? 'warn' : undefined} to="/prs" />
        <Stat value={data.prs.filter((p) => p.hasConflicts).length} label={t('conflicts')} />
      </div>
      {mine.length ? (
        <ul className="mini-list">
          {mine.slice(0, 5).map((p) => (
            <li key={p.key}>
              <button type="button" className="link-btn mini-title" onClick={() => openDrawer({ type: 'pr', projectId: p.projectId, repoId: p.repoId, id: p.id })}>{p.title}</button>
              <span className="muted small">{p.repoName} · {p.author?.displayName} · {age(p.createdAt)}</span>
            </li>
          ))}
        </ul>
      ) : <p className="muted small">{t('No pull requests are waiting on your vote.')}</p>}
    </>
  );
}

function PipelinesWidget() {
  const { openDrawer } = useApp();
  const { data, fallback } = useWidgetData('/pipelines');
  if (fallback) return fallback;
  const failing = data.filter((p) => p.health === 'failing');
  const unstable = data.filter((p) => p.health === 'unstable');
  const running = data.filter((p) => p.running.length);
  return (
    <>
      <div className="stat-row">
        <Stat value={failing.length} label={t('failing')} tone={failing.length ? 'bad' : 'ok'} to="/pipelines" />
        <Stat value={unstable.length} label={t('unstable')} tone={unstable.length ? 'warn' : undefined} to="/pipelines" />
        <Stat value={running.length} label={t('running now')} to="/pipelines" />
        <Stat value={data.length} label={t('tracked')} />
      </div>
      <ul className="mini-list">
        {[...failing, ...running.filter((p) => p.health !== 'failing')].slice(0, 5).map((p) => (
          <li key={p.key}>
            <button type="button" className="mini-title link-btn" onClick={() => openDrawer({ type: 'pipeline', key: p.key })}>{p.definition.name}</button>
            <span className="small">
              {p.running.length ? <Chip tone={p.running[0].status === 'notStarted' ? 'muted' : 'info'}>{t(p.running[0].status === 'notStarted' ? 'Queued' : 'Running')}</Chip> : <Chip tone="bad">{t('Failing')}</Chip>}
              <span className="muted"> {p.running.length ? (p.running[0].status === 'notStarted' ? t('queued {age} ago', { age: age(p.running[0].queuedAt) }) : t('started {age} ago', { age: age(p.running[0].startedAt || p.running[0].queuedAt) })) : t('{n} in a row', { n: p.failStreak })}</span>
            </span>
          </li>
        ))}
        {!failing.length && !running.length && <li className="muted small">{t('All default branches are green.')}</li>}
      </ul>
    </>
  );
}

function WorkWidget() {
  const { data, fallback } = useWidgetData('/workitems');
  const { meta } = useApp();
  if (fallback) return fallback;
  const open = data.items;
  const by = (cat) => open.filter((w) => w.stateCategory === cat).length;
  const segs = [
    { id: 'InProgress', label: t('In progress'), aria: '{n} in progress', n: by('InProgress'), cls: 'seg-doing' },
    { id: 'Resolved', label: t('Resolved'), aria: '{n} resolved', n: by('Resolved'), cls: 'seg-resolved' },
    { id: 'Proposed', label: t('Not started'), aria: '{n} not started', n: by('Proposed'), cls: 'seg-todo' },
  ];
  const total = open.length || 1;
  const blockedTag = meta.blockedTag.toLowerCase();
  const blocked = open.filter((w) => w.blocked || w.state.toLowerCase() === blockedTag || w.tags.some((tag) => tag.toLowerCase() === blockedTag)).length;
  const p1 = open.filter((w) => w.type === 'Bug' && (Number(w.priority) === 1 || String(w.severity || '').startsWith('1'))).length;
  return (
    <>
      <div className="stat-row">
        <Stat value={open.length} label={t('open items')} to="/work" />
        <Stat value={blocked} label={t('blocked')} tone={blocked ? 'bad' : undefined} to="/work?view=blocked" />
        <Stat value={p1} label={t('P1 bugs')} tone={p1 ? 'bad' : undefined} to="/work?view=bugs" />
        <Stat value={open.filter((w) => !w.assignedTo).length} label={t('unassigned')} to="/work?view=unassigned" />
      </div>
      <div className="stack-bar" role="img" aria-label={segs.map((s) => t(s.aria, { n: s.n })).join(', ')}>
        {segs.filter((s) => s.n).map((s) => <span key={s.id} className={s.cls} style={{ width: `${(s.n / total) * 100}%` }} />)}
      </div>
      <ul className="legend small">
        {segs.map((s) => <li key={s.id}><span className={`legend-swatch ${s.cls}`} />{s.label} <strong>{s.n}</strong></li>)}
      </ul>
    </>
  );
}

function TeamWidget() {
  const { data, fallback } = useWidgetData('/team');
  const { meta } = useApp();
  if (fallback) return fallback;
  const rows = data.rows.slice(0, 7);
  const max = Math.max(1, ...rows.map((r) => r.inProgress + r.reviewsPending));
  return (
    <ul className="load-list">
      {rows.map((r) => (
        <li key={r.person.id} title={t('{doing} in progress, {reviews} reviews owed, {prs} open PRs', { doing: r.inProgress, reviews: r.reviewsPending, prs: r.prsAuthored })}>
          <span className="person"><Avatar person={r.person} size={20} /><span className="truncate">{r.person.displayName}</span></span>
          <span className="load-track">
            {r.inProgress > 0 && <span className="seg-doing" style={{ width: `${(r.inProgress / max) * 100}%` }} />}
            {r.reviewsPending > 0 && <span className="seg-review" style={{ width: `${(r.reviewsPending / max) * 100}%` }} />}
          </span>
          <span className={`small load-num ${r.overloaded ? 'text-warn strong' : 'muted'}`}>{r.inProgress} · {r.reviewsPending}</span>
        </li>
      ))}
      <li className="legend small">
        <span><span className="legend-swatch seg-doing" />{t('In progress')}</span>
        <span><span className="legend-swatch seg-review" />{t('Reviews owed')}</span>
        <span className="muted">{t('Flag above {doing} / {reviews}', { doing: meta.thresholds.maxInProgressPerPerson, reviews: meta.thresholds.maxPendingReviewsPerPerson })}</span>
      </li>
    </ul>
  );
}

function FlowWidget() {
  const { data, fallback } = useWidgetData('/insights?days=14');
  if (fallback) return fallback;
  const totals = data.totals;
  const days = [...data.weekly];
  const max = Math.max(1, ...days.map((w) => w.merged));
  return (
    <>
      <div className="stat-row">
        <Stat value={totals.merged} label={t('PRs merged')} to="/insights" />
        <Stat value={hours(totals.medianCycleHours)} label={t('median to merge')} />
        <Stat value={pct(totals.buildPassRate)} label={t('build pass rate')} />
      </div>
      <div className="mini-columns" role="img" aria-label={days.map((w) => t('week of {week}: {n} merged', { week: w.week, n: w.merged })).join(', ')}>
        {days.map((w) => (
          <span key={w.week} className="mini-col" title={t('Week of {week}: {n} merged', { week: new Date(w.week).toLocaleDateString(locale(), { month: 'short', day: 'numeric' }), n: w.merged })}>
            <span className="mini-col-bar" style={{ height: `${Math.max(w.merged ? 6 : 0, (w.merged / max) * 100)}%` }} />
            <span className="mini-col-label">{w.merged}</span>
          </span>
        ))}
      </div>
      <p className="muted small">{t('Merged pull requests per week.')}</p>
    </>
  );
}

function EpicsWidget() {
  const { data, fallback } = useWidgetData('/epics');
  if (fallback) return fallback;
  const epics = data.projects.flatMap((p) => p.epics).filter((e) => e.rollup.total)
    .sort((a, b) => (b.rollup.inProgress - a.rollup.inProgress) || (b.rollup.total - a.rollup.total)).slice(0, 6);
  if (!epics.length) return <p className="muted small">{t('No open epics with backlog items.')}</p>;
  return (
    <ul className="mini-list">
      {epics.map((e) => {
        const r = e.rollup;
        return (
          <li key={e.item.id}>
            <span className="mini-title">{e.item.title}</span>
            <span className="epic-mini">
              <span className="progress-bar" aria-hidden="true">
                <span className="progress-done" style={{ width: `${(r.done / r.total) * 100}%` }} />
                <span className="progress-doing" style={{ width: `${(r.inProgress / r.total) * 100}%` }} />
              </span>
              <span className="small muted">{Math.round((r.done / r.total) * 100)}% · {r.done}/{r.total}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function MineWidget() {
  const { data, fallback } = useWidgetData('/workitems');
  const prs = useWidgetData('/prs');
  const { openDrawer } = useApp();
  if (fallback) return fallback;
  const mine = data.items.filter((w) => w.assignedTo?.id === data.me.id);
  const myPrs = prs.data ? prs.data.prs.filter((p) => p.isMine) : [];
  return (
    <ul className="mini-list">
      {myPrs.map((p) => (
        <li key={p.key}>
          <button type="button" className="link-btn mini-title" onClick={() => openDrawer({ type: 'pr', projectId: p.projectId, repoId: p.repoId, id: p.id })}>{p.title}</button>
          <span className="small"><Chip tone={REVIEW_STATE[p.reviewState].tone}>{REVIEW_STATE[p.reviewState].label}</Chip> <span className="muted">{t('your PR · {age}', { age: age(p.createdAt) })}</span></span>
        </li>
      ))}
      {mine.slice(0, 6).map((w) => (
        <li key={w.id}>
          <button type="button" className="link-btn mini-title" onClick={() => openDrawer({ type: 'workitem', id: w.id })}>{w.title}</button>
          <span className="muted small">{w.type} {w.id} · {w.state}</span>
        </li>
      ))}
      {!mine.length && !myPrs.length && <li className="muted small">{t('Nothing assigned to you.')}</li>}
    </ul>
  );
}

const PROD_TONE = { up: 'ok', degraded: 'warn', down: 'bad', unknown: 'muted' };
const PROD_LABEL = {
  get up() { return t('Up'); },
  get degraded() { return t('Degraded'); },
  get down() { return t('Down'); },
  get unknown() { return t('No data'); },
};

function ProductionWidget() {
  const { data, fallback } = useWidgetData('/production');
  if (fallback) return fallback;
  if (!data.monitors.length) return <p className="muted small">{tj('No monitors yet. {link} to watch them here.', { link: <Link to="/settings#production">{t('Add your production apps')}</Link> })}</p>;
  return (
    <ul className="mini-list">
      {data.monitors.map((m) => (
        <li key={m.id}>
          <span className="prod-row">
            <Chip tone={PROD_TONE[m.state]}>{PROD_LABEL[m.state]}</Chip>
            <Link className="mini-title" to="/production">{m.name}</Link>
          </span>
          <span className="muted small truncate">
            {tx(m.issues[0]?.text)
              || [m.last?.ok ? `${Math.round(m.last.ms)}ms` : null, m.uptime24h != null ? t('{pct} up (24h)', { pct: pct(m.uptime24h) }) : null, m.ai ? t('{pct} failing', { pct: pct(m.ai.failRate) }) : null].filter(Boolean).join(' · ')}
          </span>
        </li>
      ))}
    </ul>
  );
}
