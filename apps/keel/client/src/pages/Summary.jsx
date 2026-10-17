import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useApi, useApp } from '../context.js';
import { dateTime } from '../format.js';
import { Chip, Empty, ErrorBox, Loading, PageHeader, TypeLabel } from '../ui.jsx';
import { locale, t } from '../i18n.js';
import { useProjectLabel } from '../orgs.js';
import { DEPLOY_STATUS } from './DeployDetail.jsx';

const DAY = 86_400_000;
// Longer lists show this many until you ask for the rest.
const SHORT = 6;
const day = (iso, opts = {}) => new Date(iso).toLocaleDateString(locale(), { day: 'numeric', month: 'short', timeZone: 'UTC', ...opts });
const shiftWeek = (week, n) => new Date(Date.parse(week) + n * 7 * DAY).toISOString().slice(0, 10);

/** Deploys by environment, the environment deployed most recently first. */
function byEnvironment(deploys) {
  const groups = new Map();
  for (const d of deploys) {
    const key = `${d.org || ''}:${d.target}`;
    if (!groups.has(key)) groups.set(key, { key, target: d.target, org: d.org, deploys: [] });
    groups.get(key).deploys.push(d);
  }
  return [...groups.values()].map((g) => ({
    ...g,
    ok: g.deploys.filter((d) => d.status === 'succeeded').length,
    failed: g.deploys.filter((d) => d.status !== 'succeeded').length,
    latest: g.deploys[0],
  }));
}

/** The summary as plain text, to paste into an email, Teams or Slack. */
function asText(s, projectLabel) {
  const title = t('Week of {from} – {to}', { from: day(s.from), to: day(s.to, { year: 'numeric' }) });
  const tot = s.totals;
  const lines = [
    title,
    '',
    `• ${t(tot.finished === 1 ? '{n} item finished' : '{n} items finished', { n: tot.finished })} (${t('{features} features and stories, {bugs} bugs fixed', { features: tot.features, bugs: tot.bugs })})`,
    `• ${t(tot.merged === 1 ? '{n} pull request merged' : '{n} pull requests merged', { n: tot.merged })}`,
    `• ${t(tot.deploys === 1 ? '{n} deploy to production' : '{n} deploys to production', { n: tot.deploys })}${tot.failedDeploys ? ` (${t('{n} failed', { n: tot.failedDeploys })})` : ''}`,
    `• ${t(tot.blocked === 1 ? '{n} item blocked right now' : '{n} items blocked right now', { n: tot.blocked })}`,
  ];
  const list = (heading, items) => {
    if (!items.length) return;
    lines.push('', heading);
    for (const w of items) lines.push(`- ${w.title} (${projectLabel(w.projectName, w.org)}, ${w.type} #${w.id}${w.assignedTo ? `, ${w.assignedTo}` : ''})`);
  };
  list(t('Finished'), s.features);
  list(t('Bugs fixed'), s.bugs);
  if (s.deploys.length) {
    lines.push('', t('Deployed to production'));
    for (const g of byEnvironment(s.deploys)) {
      const count = t(g.ok === 1 ? '{n} deploy' : '{n} deploys', { n: g.ok });
      lines.push(`- ${g.target}: ${count}${g.failed ? `, ${t('{n} failed', { n: g.failed })}` : ''} (${t('latest {label}, {date}', { label: g.latest.label, date: dateTime(g.latest.at) })})`);
    }
  }
  list(t('Blocked right now'), s.blocked);
  return `${lines.join('\n')}\n`;
}

/** The first SHORT entries of a list, with "Show all" for the rest. */
function useShort(list) {
  const [all, setAll] = useState(false);
  const shown = all ? list : list.slice(0, SHORT);
  const more = list.length > SHORT && (
    <button type="button" className="link-btn small summary-more" onClick={() => setAll((a) => !a)}>
      {all ? t('Show fewer') : t('Show all {n}', { n: list.length })}
    </button>
  );
  return [shown, more];
}

/** Work items as a list; each opens in the side panel. */
function Items({ items, empty, onOpen, projectLabel }) {
  const [shown, more] = useShort(items);
  if (!items.length) return <p className="muted small">{empty}</p>;
  return (
    <>
      <ul className="summary-list">
        {shown.map((w) => (
          <li key={`${w.org || ''}:${w.id}`}>
            <button type="button" className="row-link" onClick={() => onOpen(w)}>{w.title}</button>
            <div className="sub">
              <TypeLabel type={w.type} />
              <span>{projectLabel(w.projectName, w.org)}</span>
              <span className="mono">#{w.id}</span>
              {w.assignedTo && <span>{w.assignedTo}</span>}
            </div>
          </li>
        ))}
      </ul>
      {more}
    </>
  );
}

/** Pull requests merged, per repository. */
function MergedByRepo({ repos }) {
  const [shown, more] = useShort(repos);
  if (!repos.length) return <p className="muted small">{t('No pull requests merged.')}</p>;
  return (
    <>
      <ul className="summary-list">
        {shown.map((r) => (
          <li key={`${r.projectName}/${r.repoName}`} className="summary-count">
            <span>{r.repoName} <span className="muted small">{r.projectName}</span></span>
            <span className="strong">{t(r.count === 1 ? '{n} pull request' : '{n} pull requests', { n: r.count })}</span>
          </li>
        ))}
      </ul>
      {more}
    </>
  );
}

/**
 * One week at a glance, for everyone: what got finished, merged and deployed,
 * and what's blocked now. The week is in the address (?week=), so the link
 * can be shared; "Copy as text" gives a version for email or chat.
 */
export default function Summary() {
  const { openDrawer, toast } = useApp();
  const projectLabel = useProjectLabel();
  const [params, setParams] = useSearchParams();
  const week = params.get('week') || '';
  const { data, error, reload, loading } = useApi(`/summary${week ? `?week=${encodeURIComponent(week)}` : ''}`);

  const go = (w) => setParams(w ? { week: w } : {}, { replace: false });
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(asText(data, projectLabel));
      toast(t('Summary copied. Paste it into an email or chat.'));
    } catch {
      toast(t('Couldn’t copy. Your browser blocked the clipboard.'), 'bad');
    }
  };

  const title = data ? t('Week of {from} – {to}', { from: day(data.from), to: day(data.to, { year: 'numeric' }) }) : '';
  const header = (
    <PageHeader title={t('Weekly summary')} sub={data ? `${title}${data.current ? ` · ${t('so far')}` : ''}${loading ? ` · ${t('Loading…')}` : ''}` : null}>
      {data && (
        <>
          <div className="segmented segmented-compact" role="group" aria-label={t('Week')}>
            <button type="button" onClick={() => go(shiftWeek(data.week, -1))}>‹ {t('Previous')}</button>
            <button type="button" className={data.current ? 'on' : ''} onClick={() => go('')}>{t('This week')}</button>
            <button type="button" disabled={data.current} onClick={() => go(shiftWeek(data.week, 1))}>{t('Next')} ›</button>
          </div>
          <button type="button" className="btn btn-small" onClick={copy}>{t('Copy as text')}</button>
        </>
      )}
    </PageHeader>
  );
  if (!data) return <div className="page">{header}{error ? <ErrorBox error={error} onRetry={reload} /> : <Loading />}</div>;

  const tot = data.totals;
  const facts = [
    [t('Finished'), tot.finished, t('{features} features and stories, {bugs} bugs fixed', { features: tot.features, bugs: tot.bugs })],
    [t('Pull requests merged'), tot.merged, t(data.mergedByRepo.length === 1 ? 'in {n} repo' : 'in {n} repos', { n: data.mergedByRepo.length })],
    [t('Deploys to production'), tot.deploys, tot.failedDeploys ? t('{n} failed', { n: tot.failedDeploys }) : t('none failed')],
    [t('Blocked right now'), tot.blocked, t('{n} in progress', { n: tot.inProgress })],
  ];
  const openItem = (w) => openDrawer({ type: 'workitem', id: w.id, org: w.org });
  const list = (items, empty) => <Items items={items} empty={empty} onOpen={openItem} projectLabel={projectLabel} />;

  return (
    <div className="page summary-page">
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

      {!tot.finished && !tot.merged && !tot.deploys && !tot.blocked ? (
        <Empty title={t('Nothing recorded this week yet.')}>{t('Finished work items, merged pull requests and production deploys show up here as they happen.')}</Empty>
      ) : (
        <div className="summary-grid">
          <section className="panel">
            <h2 className="section-title">{t('Finished')} <span className="muted small">{data.features.length}</span></h2>
            {list(data.features, t('No features or stories finished.'))}
          </section>
          <section className="panel">
            <h2 className="section-title">{t('Bugs fixed')} <span className="muted small">{data.bugs.length}</span></h2>
            {list(data.bugs, t('No bugs fixed.'))}
          </section>
          <section className="panel">
            <h2 className="section-title">{t('Deployed to production')} <span className="muted small">{data.deploys.length}</span></h2>
            {data.deploys.length ? (
              <ul className="summary-list">
                {byEnvironment(data.deploys).map((g) => {
                  const status = DEPLOY_STATUS[g.latest.status] || { tone: 'muted', label: g.latest.status };
                  return (
                    <li key={g.key} className="summary-count">
                      <div>
                        <span className="strong">{g.target}</span>
                        <div className="sub">
                          <span>{t('latest')}</span>
                          <a href={g.latest.webUrl} target="_blank" rel="noreferrer noopener">{g.latest.label}</a>
                          <span>{dateTime(g.latest.at)}</span>
                          {g.latest.status !== 'succeeded' && <Chip tone={status.tone}>{t(status.label)}</Chip>}
                        </div>
                      </div>
                      <span className="summary-n">
                        <span className="strong">{t(g.ok === 1 ? '{n} deploy' : '{n} deploys', { n: g.ok })}</span>
                        {g.failed > 0 && <span className="text-bad small">{t('{n} failed', { n: g.failed })}</span>}
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : <p className="muted small">{t('No production deploys.')}</p>}
          </section>
          <section className="panel">
            <h2 className="section-title">{t('Code merged')} <span className="muted small">{tot.merged}</span></h2>
            <MergedByRepo repos={data.mergedByRepo} />
          </section>
          <section className="panel">
            <h2 className="section-title">{t('Blocked right now')} <span className="muted small">{data.blocked.length}</span></h2>
            {list(data.blocked, t('Nothing is blocked.'))}
          </section>
        </div>
      )}
    </div>
  );
}
