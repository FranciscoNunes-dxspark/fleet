// The Desk: Keel as a triage tool, like a mail client. Queues on the left (what to do now, then
// by kind), one list in the middle mixing every kind of thing, and the selected entry in full on
// the right, where you act on it: vote on a pull request, move a work item, decide an approval.
// Keyboard-first: j/k (or the arrows) move and the right pane follows, 1–8 pick a queue,
// s snoozes for a day and o opens it in Azure DevOps or GitHub. The queues are views.js's.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useApp } from '../context.js';
import { age } from '../format.js';
import { ExternalLink, Loading, useMedia } from '../ui.jsx';
import { Icon } from '../icons.jsx';
import { useSticky } from '../sticky.js';
import { t, tx } from '../i18n.js';
import { itemTitle, kindLabel, openInboxItem } from '../pages/Inbox.jsx';
import PrDetail from '../pages/PrDetail.jsx';
import WorkItemDetail from '../pages/WorkItemDetail.jsx';
import PipelineDetail from '../pages/PipelineDetail.jsx';
import { ApprovalsPanel } from '../pages/Releases.jsx';
import { DESK_QUEUES, deskQueues, monitorIdOf, serviceTiles } from './views.js';
import { useLine } from './LineShell.jsx';
import { ServiceTile } from './Control.jsx';
import { Button } from '@radix-ui/themes';

const ICONS = { production: 'production', approval: 'pipelines', review: 'pullRequests', pr: 'pullRequests', work: 'workItems', pipeline: 'pipelines', team: 'team' };

const queueName = (id) => ({
  now: t('Act now'), review: t('Your reviews'), approval: t('Approvals'), broken: t('Broken'),
  pr: t('Pull requests'), work: t('Work items'), team: t('Team load'), all: t('Everything'),
})[id];

// Typing somewhere, or holding a modifier, means the keys aren't for the Desk.
const typing = (e) => e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented
  || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable || !!e.target.closest?.('[role="dialog"]');

export default function Desk() {
  const { data, loading } = useLine();
  const { refresh, toast, openDrawer } = useApp();
  const navigate = useNavigate();
  // Narrower, there's no room for the right pane: an entry opens the way the Inbox opens it.
  const narrow = useMedia('(max-width: 1100px)');
  const [queueId, setQueueId] = useSticky('desk.queue', 'now');
  const [selected, setSelected] = useState(null);
  const listRef = useRef(null);

  const queues = useMemo(() => deskQueues(data.attention?.items), [data.attention]);
  const queue = queues.find((q) => q.id === queueId) || queues[0];
  const items = queue.items;
  const at = Math.max(0, items.findIndex((i) => i.key === selected));
  const current = items[at] || null;

  // Keep a selection: the first entry when there's none, or the next one when it leaves the queue.
  useEffect(() => {
    if (items.length && !items.some((i) => i.key === selected)) setSelected(items[Math.min(at, items.length - 1)].key);
  }, [items, selected, at]);

  const snooze = async (item) => {
    if (!item) return;
    const next = items[at + 1] || items[at - 1];
    try {
      await api('/attention/snooze', { method: 'POST', body: { key: item.key, days: 1 } });
      toast(t('Snoozed for a day'));
      setSelected(next?.key ?? null);
      refresh();
    } catch (e) {
      toast(e.message, 'bad');
    }
  };

  const keys = useRef(null);
  keys.current = (e) => {
    if (typing(e)) return;
    const inDetail = !!e.target.closest?.('.desk-detail');
    const step = e.key === 'j' || (e.key === 'ArrowDown' && !inDetail) ? 1 : e.key === 'k' || (e.key === 'ArrowUp' && !inDetail) ? -1 : 0;
    if (step && items.length) {
      e.preventDefault();
      setSelected(items[Math.min(items.length - 1, Math.max(0, at + step))].key);
    } else if (/^[1-8]$/.test(e.key)) {
      e.preventDefault();
      setQueueId(DESK_QUEUES[Number(e.key) - 1].id);
    } else if ((e.key === 'Enter' || e.key === 'o') && narrow && current && !e.target.closest?.('button, a')) {
      e.preventDefault();
      openInboxItem(current, openDrawer, navigate);
    } else if (e.key === 's' && current) {
      e.preventDefault();
      snooze(current);
    } else if (e.key === 'o' && current?.webUrl) {
      e.preventDefault();
      window.open(current.webUrl, '_blank', 'noopener');
    }
  };
  useEffect(() => {
    const onKey = (e) => keys.current(e);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selected, queueId]);

  if (!data.attention) return <Loading />;

  return (
    <div className="desk">
      <nav className="desk-queues" aria-label={t('Queues')}>
        <h1 className="desk-title">{t('Desk')}</h1>
        {queues.map((q, i) => (
          <button key={q.id} type="button" className={`desk-queue${q.id === queue.id ? ' on' : ''}`} aria-current={q.id === queue.id || undefined} onClick={() => setQueueId(q.id)} disabled={!q.count && q.id !== 'all'}>
            <span className="desk-queue-key" aria-hidden="true">{i + 1}</span>
            <span className="desk-queue-name">{queueName(q.id)}</span>
            <span className={`desk-queue-n${q.high && q.id !== 'now' ? ' hot' : ''}`}>{q.count}</span>
          </button>
        ))}
        <p className="key-hints desk-hints" aria-label={t('Keyboard')}>
          <span><kbd>j</kbd><kbd>k</kbd> {t('Move')}</span>
          <span><kbd>1</kbd>–<kbd>8</kbd> {t('Queue')}</span>
          <span><kbd>s</kbd> {t('Snooze a day')}</span>
          <span><kbd>o</kbd> {t('Open outside Keel')}</span>
        </p>
      </nav>

      <section className="desk-list" aria-label={queueName(queue.id)}>
        <header className="desk-list-head">
          <h2>{queueName(queue.id)}</h2>
          <span className="muted small">{t(items.length === 1 ? '1 entry' : '{n} entries', { n: items.length })}</span>
        </header>
        {!items.length && <p className="desk-empty">{loading ? t('Loading') : t('Nothing in this queue.')}</p>}
        <ol className="desk-rows" ref={listRef} role="listbox" aria-label={queueName(queue.id)}>
          {items.map((item) => (
            <li
              key={item.key}
              role="option"
              aria-selected={item.key === current?.key}
              className={`desk-row sev-${item.severity}${item.key === current?.key ? ' on' : ''}`}
              onClick={() => { setSelected(item.key); if (narrow) openInboxItem(item, openDrawer, navigate); }}
            >
              <span className="desk-row-icon" aria-hidden="true"><Icon name={ICONS[item.kind] || 'inbox'} size={15} /></span>
              <span className="desk-row-main">
                <span className="desk-row-top">
                  <span className="desk-row-kind">{kindLabel(item.kind)}</span>
                  {item.at && <span className="desk-row-age">{age(item.at)}</span>}
                </span>
                <span className="desk-row-title">{itemTitle(item)}</span>
                {item.reasons[0] && <span className={`desk-row-reason reason-${item.reasons[0].severity}`}>{tx(item.reasons[0].text)}</span>}
              </span>
            </li>
          ))}
        </ol>
      </section>

      <section className="desk-detail" aria-label={t('Details')} tabIndex={-1}>
        {current ? <Detail item={current} data={data} onSnooze={() => snooze(current)} /> : <p className="desk-empty">{t('Pick an entry to see it here.')}</p>}
      </section>
    </div>
  );
}

/** The selected entry in full: Keel's own panel where it has one, else what's wrong and where to go. */
function Detail({ item, data, onSnooze }) {
  const navigate = useNavigate();
  const { openDrawer } = useApp();
  const target = item.target;
  const bar = (
    <div className="desk-detail-bar">
      <span className="desk-detail-kind">{kindLabel(item.kind)}</span>
      <Button size="1" variant="ghost" color="gray" type="button" onClick={onSnooze}>{t('Snooze a day')}</Button>
      <ExternalLink href={item.webUrl} />
    </div>
  );
  if (target.type === 'pr') return <>{bar}<PrDetail key={`${target.repoId}:${target.id}`} target={target} /></>;
  if (target.type === 'workitem') return <>{bar}<WorkItemDetail key={`${target.org || ''}:${target.id}`} id={target.id} org={target.org} /></>;
  if (target.type === 'pipeline' && target.key) return <>{bar}<PipelineDetail key={target.key} target={target} /></>;

  const approvals = target.type === 'approval' ? (data.approvals || []).filter((a) => a.key === target.key) : [];
  const monitorId = monitorIdOf(item);
  const tile = monitorId ? serviceTiles(data).find((x) => x.id === monitorId) : null;
  const where = { approval: t('Pipelines'), release: t('Releases'), production: t('Production'), person: t('Team'), advisory: t('Security advisories') }[target.type];
  return (
    <div className="detail desk-summary">
      {bar}
      <div className="detail-kicker">{tx(item.context)}</div>
      <h2 className="detail-title">{itemTitle(item)}</h2>
      <ul className="desk-reasons">
        {item.reasons.map((r) => <li key={r.code + r.text} className={`reason reason-${r.severity}`}>{tx(r.text)}</li>)}
      </ul>
      {approvals.length > 0 && <ApprovalsPanel approvals={approvals} />}
      {tile && <ol className="tiles tiles-one"><ServiceTile tile={tile} /></ol>}
      {where && (
        <div className="detail-actions">
          <Button size="2" variant="outline" color="gray" type="button" onClick={() => openInboxItem(item, openDrawer, navigate)}>{t('Go to {page}', { page: where })} →</Button>
        </div>
      )}
    </div>
  );
}
