import { useState } from 'react';
import { useSticky } from '../sticky.js';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useApi, useApp } from '../context.js';
import { age } from '../format.js';
import { Empty, ErrorBox, ExternalLink, Loading, PageHeader, typeSlug, useTypeColor } from '../ui.jsx';
import { t, tx } from '../i18n.js';

// Labels are getters so they follow the current language.
const KINDS = [
  { id: 'all', get label() { return t('Everything'); } },
  { id: 'production', get label() { return t('Production'); } },
  { id: 'approval', get label() { return t('Approvals'); } },
  { id: 'review', get label() { return t('Your reviews'); } },
  { id: 'pr', get label() { return t('Pull requests'); } },
  { id: 'work', get label() { return t('Work items'); } },
  { id: 'pipeline', get label() { return t('Pipelines'); } },
  { id: 'team', get label() { return t('Team load'); } },
];

const SEVERITY = {
  get high() { return t('Act now'); },
  get medium() { return t('Today'); },
  get low() { return t('When you can'); },
};

// Keel writes the titles of these kinds; the others (pull requests, work items) carry the
// Azure DevOps title, shown as is so templates can't rewrite e.g. a PR titled "Site is down".
const KEEL_TITLES = ['production', 'approval', 'pipeline', 'team'];
const itemTitle = (i) => (KEEL_TITLES.includes(i.kind) ? tx(i.title) : i.title);

export default function Inbox() {
  const { data, error, loading, reload } = useApi('/attention');
  const { openDrawer, refresh, toast } = useApp();
  const typeColor = useTypeColor();
  const navigate = useNavigate();
  const [kind, setKind] = useSticky('inbox.kind', 'all');

  if (!data) return error ? <ErrorBox error={error} onRetry={reload} /> : <Loading />;

  const counts = Object.fromEntries(KINDS.map((k) => [k.id, k.id === 'all' ? data.items.length : data.items.filter((i) => i.kind === k.id).length]));
  const items = data.items.filter((i) => kind === 'all' || i.kind === kind);
  const s = data.summary;

  const open = (item) => {
    const target = item.target;
    if (target.type === 'pr' || target.type === 'workitem') openDrawer(target);
    else if (target.type === 'pipeline' || target.type === 'approval') navigate('/pipelines');
    else if (target.type === 'release') navigate('/pipelines?tab=releases');
    else if (target.type === 'production') navigate('/production');
    else if (target.type === 'person') navigate('/team');
  };

  const snooze = async (item, days) => {
    try {
      await api('/attention/snooze', { method: 'POST', body: { key: item.key, days } });
      toast(days === 1 ? t('Snoozed for a day') : t('Snoozed for {n} days', { n: days }));
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
    s.productionIssues && t(s.productionIssues === 1 ? '{n} production app needs attention' : '{n} production apps need attention', { n: s.productionIssues }),
    s.approvals && t(s.approvals === 1 ? '{n} deployment waiting for your approval' : '{n} deployments waiting for your approval', { n: s.approvals }),
    s.myReviews && t(s.myReviews === 1 ? '{n} review waiting on you' : '{n} reviews waiting on you', { n: s.myReviews }),
    s.failingPipelines && t(s.failingPipelines === 1 ? '{n} pipeline red' : '{n} pipelines red', { n: s.failingPipelines }),
    s.blockedItems && t(s.blockedItems === 1 ? '{n} blocked item' : '{n} blocked items', { n: s.blockedItems }),
    s.p1Bugs && t(s.p1Bugs === 1 ? '{n} open P1 bug' : '{n} open P1 bugs', { n: s.p1Bugs }),
  ].filter(Boolean);

  return (
    <div className="page">
      <PageHeader
        title={t('Inbox')}
        sub={headline.length ? headline.join(', ') : t('Nothing urgent across your tracked projects.')}
      >
        {loading && <span className="spinner" aria-label={t('Refreshing')} />}
      </PageHeader>

      <div className="segmented" role="tablist" aria-label={t('Filter inbox')}>
        {KINDS.map((k) => (
          <button key={k.id} type="button" role="tab" aria-selected={kind === k.id} className={kind === k.id ? 'on' : ''} onClick={() => setKind(k.id)} disabled={k.id !== 'all' && !counts[k.id]}>
            {k.label}<span className="seg-count">{counts[k.id]}</span>
          </button>
        ))}
      </div>

      {!items.length && (
        <Empty title={data.items.length ? t('Nothing in this filter.') : t('Inbox zero.')} mood={data.items.length ? undefined : 'sleep'}>
          {data.items.length ? t('Pick another filter above.') : `${t('Nothing needs you, so Pinch is having a nap.')} ${t('Reviews, red pipelines, blocked items and stale PRs will show up here as they happen.')}`}
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
                <li key={item.key} className={`strip sev-${item.severity}${item.workItemType ? ` wi-strip wi-${typeSlug(item.workItemType)}` : ''}`} style={item.workItemType ? typeColor(item.workItemType, item.workItemTypeColor) : undefined}>
                  <div className="strip-main">
                    <button type="button" className="strip-title" onClick={() => open(item)}>{itemTitle(item)}</button>
                    <div className="strip-context">{tx(item.context)}</div>
                    <ul className="reasons">
                      {item.reasons.map((r) => <li key={r.code + r.text} className={`reason reason-${r.severity}`}>{tx(r.text)}</li>)}
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
          {t(data.snoozedCount === 1 ? '{n} snoozed item hidden.' : '{n} snoozed items hidden.', { n: data.snoozedCount })}{' '}
          <button type="button" className="link-btn" onClick={clearSnoozes}>{t('Show them again')}</button>
        </p>
      )}
    </div>
  );
}

function SnoozeMenu({ onPick }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="menu-wrap">
      <button type="button" className="btn btn-ghost btn-small" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{t('Snooze')}</button>
      {open && (
        <span className="menu" role="menu" onMouseLeave={() => setOpen(false)}>
          {[[1, 'Until tomorrow'], [3, 'For 3 days'], [7, 'For a week']].map(([d, label]) => (
            <button key={d} type="button" role="menuitem" onClick={() => { setOpen(false); onPick(d); }}>{t(label)}</button>
          ))}
        </span>
      )}
    </span>
  );
}
