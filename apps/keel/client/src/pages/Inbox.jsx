import { useState } from 'react';
import { useSticky } from '../sticky.js';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useApi, useApp } from '../context.js';
import { age } from '../format.js';
import { Empty, ErrorBox, ExternalLink, Loading, PageHeader } from '../ui.jsx';

const KINDS = [
  { id: 'all', label: 'Everything' },
  { id: 'production', label: 'Production' },
  { id: 'approval', label: 'Approvals' },
  { id: 'review', label: 'Your reviews' },
  { id: 'pr', label: 'Pull requests' },
  { id: 'work', label: 'Work items' },
  { id: 'pipeline', label: 'Pipelines' },
  { id: 'team', label: 'Team load' },
];

const SEVERITY = { high: 'Act now', medium: 'Today', low: 'When you can' };

export default function Inbox() {
  const { data, error, loading, reload } = useApi('/attention');
  const { openDrawer, refresh, toast } = useApp();
  const navigate = useNavigate();
  const [kind, setKind] = useSticky('inbox.kind', 'all');

  if (!data) return error ? <ErrorBox error={error} onRetry={reload} /> : <Loading />;

  const counts = Object.fromEntries(KINDS.map((k) => [k.id, k.id === 'all' ? data.items.length : data.items.filter((i) => i.kind === k.id).length]));
  const items = data.items.filter((i) => kind === 'all' || i.kind === kind);
  const s = data.summary;

  const open = (item) => {
    const t = item.target;
    if (t.type === 'pr' || t.type === 'workitem') openDrawer(t);
    else if (t.type === 'pipeline' || t.type === 'approval') navigate('/pipelines');
    else if (t.type === 'release') navigate('/pipelines?tab=releases');
    else if (t.type === 'production') navigate('/production');
    else if (t.type === 'person') navigate('/team');
  };

  const snooze = async (item, days) => {
    try {
      await api('/attention/snooze', { method: 'POST', body: { key: item.key, days } });
      toast(`Snoozed for ${days === 1 ? 'a day' : `${days} days`}`);
      refresh();
    } catch (e) {
      toast(e.message, 'bad');
    }
  };

  const clearSnoozes = async () => {
    await api('/attention/clear-snoozes', { method: 'POST' });
    refresh();
  };

  const headline = [
    s.productionIssues && `${s.productionIssues} production app${s.productionIssues === 1 ? '' : 's'} need${s.productionIssues === 1 ? 's' : ''} attention`,
    s.approvals && `${s.approvals} deployment${s.approvals === 1 ? '' : 's'} waiting for your approval`,
    s.myReviews && `${s.myReviews} review${s.myReviews === 1 ? '' : 's'} waiting on you`,
    s.failingPipelines && `${s.failingPipelines} pipeline${s.failingPipelines === 1 ? '' : 's'} red`,
    s.blockedItems && `${s.blockedItems} blocked item${s.blockedItems === 1 ? '' : 's'}`,
    s.p1Bugs && `${s.p1Bugs} open P1 bug${s.p1Bugs === 1 ? '' : 's'}`,
  ].filter(Boolean);

  return (
    <div className="page">
      <PageHeader
        title="Inbox"
        sub={headline.length ? headline.join(', ') : 'Nothing urgent across your tracked projects.'}
      >
        {loading && <span className="spinner" aria-label="Refreshing" />}
      </PageHeader>

      <div className="segmented" role="tablist" aria-label="Filter inbox">
        {KINDS.map((k) => (
          <button key={k.id} type="button" role="tab" aria-selected={kind === k.id} className={kind === k.id ? 'on' : ''} onClick={() => setKind(k.id)} disabled={k.id !== 'all' && !counts[k.id]}>
            {k.label}<span className="seg-count">{counts[k.id]}</span>
          </button>
        ))}
      </div>

      {!items.length && (
        <Empty title={data.items.length ? 'Nothing in this filter.' : 'Inbox zero.'}>
          {data.items.length ? 'Pick another filter above.' : 'Reviews, red pipelines, blocked items and stale PRs will show up here as they happen.'}
        </Empty>
      )}

      {['high', 'medium', 'low'].map((sev) => {
        const group = items.filter((i) => i.severity === sev);
        if (!group.length) return null;
        return (
          <section key={sev} className="strip-group" aria-label={SEVERITY[sev]}>
            <h2 className={`group-title sev-text-${sev}`}>{SEVERITY[sev]} <span className="muted">{group.length}</span></h2>
            <ol className="strips">
              {group.map((item) => (
                <li key={item.key} className={`strip sev-${item.severity}`}>
                  <div className="strip-main">
                    <button type="button" className="strip-title" onClick={() => open(item)}>{item.title}</button>
                    <div className="strip-context">{item.context}</div>
                    <ul className="reasons">
                      {item.reasons.map((r) => <li key={r.code + r.text} className={`reason reason-${r.severity}`}>{r.text}</li>)}
                    </ul>
                  </div>
                  <div className="strip-side">
                    {item.at && <span className="strip-age" title={new Date(item.at).toLocaleString()}>{age(item.at)}</span>}
                    <div className="strip-actions">
                      <ExternalLink href={item.webUrl}>Azure DevOps</ExternalLink>
                      <SnoozeMenu onPick={(d) => snooze(item, d)} />
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          </section>
        );
      })}

      {data.snoozedCount > 0 && (
        <p className="muted small snoozed-note">
          {data.snoozedCount} snoozed item{data.snoozedCount === 1 ? '' : 's'} hidden.{' '}
          <button type="button" className="link-btn" onClick={clearSnoozes}>Show them again</button>
        </p>
      )}
    </div>
  );
}

function SnoozeMenu({ onPick }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="menu-wrap">
      <button type="button" className="btn btn-ghost btn-small" aria-expanded={open} onClick={() => setOpen((o) => !o)}>Snooze</button>
      {open && (
        <span className="menu" role="menu" onMouseLeave={() => setOpen(false)}>
          {[[1, 'Until tomorrow'], [3, 'For 3 days'], [7, 'For a week']].map(([d, label]) => (
            <button key={d} type="button" role="menuitem" onClick={() => { setOpen(false); onPick(d); }}>{label}</button>
          ))}
        </span>
      )}
    </span>
  );
}
