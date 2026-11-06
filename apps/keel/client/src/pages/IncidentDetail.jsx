import { useState } from 'react';
import { api } from '../api.js';
import { useApi, useApp } from '../context.js';
import { downloadText } from './ReleaseNotes.jsx';
import { deployStatus } from './DeployDetail.jsx';
import { age, dateTime, hours } from '../format.js';
import { Chip, Confirm, ErrorBox, ExternalLink, Loading, TypeLabel } from '../ui.jsx';
import { RiskReasons, RiskScore } from '../risk.jsx';
import { incidentMarkdown } from '../incident.js';
import { t, tx } from '../i18n.js';
import { Button } from '@radix-ui/themes';

const enc = encodeURIComponent;
const HOUR = 3_600_000;

/**
 * What broke production (server/domain/incident.js): for a monitor that's down or degraded, when it
 * turned bad, the deploys into its environment just before, what the latest shipped with each pull
 * request's risk, who approved them, the timeline, and going back to the last good release. Opened
 * from a monitor on Production and from a down or degraded card on the Line's Live station.
 */
export default function IncidentDetail({ target }) {
  const { data, error, reload } = useApi(`/production/incident/${enc(target.id)}`);
  if (!data) return error ? <ErrorBox error={error} onRetry={reload} /> : <Loading />;
  const m = data.monitor;
  if (!data.active) {
    return (
      <div className="detail incident-detail">
        <h2 className="detail-title">{m.name}</h2>
        <p className="callout">{t('{monitor} is not down or degraded right now, so there is no incident to look into.', { monitor: m.name })}</p>
      </div>
    );
  }
  return <Incident data={data} />;
}

function Incident({ data }) {
  const { openDrawer, toast, can, refresh } = useApp();
  const [busy, setBusy] = useState(false);
  const m = data.monitor;
  const down = m.state === 'down';
  const latest = data.suspects?.[0];
  const shipped = data.shipped;
  const markdown = () => incidentMarkdown(data, { translate: t, serverText: tx, when: dateTime });
  const openDeploy = (d) => openDrawer({ type: 'deploy', projectId: data.environment.projectId, target: data.environment.key, id: d.id });
  const plan = data.redeploy;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(markdown());
      toast(t('Incident timeline copied as Markdown'));
    } catch {
      toast(t('Copy failed. Select the text and copy it yourself.'), 'bad');
    }
  };
  const redeploy = async () => {
    setBusy(true);
    try {
      const comment = t('Rolled back from Keel: {monitor} {state} since {when}', { monitor: m.name, state: t(down ? 'down' : 'degraded'), when: dateTime(m.start) });
      await api('/releases/deploy', { method: 'POST', body: { projectId: plan.projectId, releaseId: plan.releaseId, environmentId: plan.environmentId, comment } });
      toast(t('Deploying {release} to {stage}', { release: plan.label, stage: plan.stage }));
      refresh();
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="detail incident-detail">
      <div className="detail-kicker">{[t('Incident'), data.environment?.name].filter(Boolean).join(' · ')}</div>
      <h2 className="detail-title">{m.name}</h2>
      <div className="chips">
        <Chip tone={down ? 'bad' : 'warn'}>{t(down ? 'Down' : 'Degraded')}</Chip>
        <span className="muted small">{t(down ? 'Went down {age} ago' : 'Degraded for {age}', { age: age(m.start) })} · {dateTime(m.start)}</span>
      </div>

      {m.issues.length > 0 && (
        <ul className="reasons monitor-issues">
          {m.issues.filter((i) => i.severity !== 'low').map((i) => <li key={i.code} className={`reason reason-${i.severity}`}>{tx(i.text)}</li>)}
        </ul>
      )}

      {data.unlinked && <p className="callout">{t("This monitor isn't linked to what deploys it, so Keel can't tell which deploy came before. Link it in Settings → Production monitors.")}</p>}

      {!data.unlinked && (
        <section className="detail-section">
          <h3>{t('Deploys just before')}</h3>
          {!data.suspects.length && <p className="muted small">{t('No deploy before it in the last 90 days.')}</p>}
          {latest && latest.gapMs > 24 * HOUR && <p className="callout">{t('Nothing was deployed in the day before it turned bad: the last deploy was {n} earlier, so it may not be the cause.', { n: hours(latest.gapMs / HOUR) })}</p>}
          <ul className="deploy-list">
            {data.suspects.map((d) => {
              const s = deployStatus(d.status);
              const approved = d.approvals.filter((a) => a.status === 'approved').map((a) => a.by).filter(Boolean);
              const rejected = d.approvals.filter((a) => a.status === 'rejected').map((a) => a.by).filter(Boolean);
              return (
                <li key={d.id}>
                  <button type="button" className="row-link" onClick={() => openDeploy(d)}>{d.label}</button>
                  <div className="sub">
                    <Chip tone={s.tone}>{t(s.label)}</Chip>
                    <span>{dateTime(d.at)}</span>
                    <span>{t('{n} before it turned bad', { n: hours(Math.max(0, d.gapMs) / HOUR) })}</span>
                    {d.by && <span>{d.by}</span>}
                    {approved.length > 0 && <span>{t('approved by {names}', { names: approved.join(', ') })}</span>}
                    {rejected.length > 0 && <span>{t('rejected by {names}', { names: rejected.join(', ') })}</span>}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {shipped && (
        <section className="detail-section">
          <h3>{t('What {label} shipped', { label: latest.label })}</h3>
          {shipped.unknown && <p className="muted small">{t("Azure DevOps didn't say which commit this deploy shipped, so its changes can't be listed.")}</p>}
          {!shipped.unknown && !shipped.pullRequests.length && !shipped.directCommits.length && <p className="muted small">{t('Nothing new was shipped.')}</p>}
          {shipped.pullRequests.length > 0 && (
            <ul className="deploy-list">
              {[...shipped.pullRequests].sort((a, b) => (b.risk?.score ?? -1) - (a.risk?.score ?? -1)).map((p) => (
                <li key={p.id}>
                  <button type="button" className="row-link" onClick={() => openDrawer({ type: 'pr', projectId: p.projectId, repoId: p.repoId, id: p.id })}>{p.title}</button>
                  <div className="sub"><RiskScore risk={p.risk} /><span className="mono">!{p.id}</span>{p.author && <span>{p.author}</span>}{p.mergedAt && <span>{t('merged {date}', { date: dateTime(p.mergedAt) })}</span>}</div>
                  {p.risk && <details className="deploy-pr-commits"><summary className="small muted">{t('Why this risk')}</summary><RiskReasons risk={p.risk} /></details>}
                </li>
              ))}
            </ul>
          )}
          {shipped.directCommits.length > 0 && <p className="muted small">{t(shipped.directCommits.length === 1 ? 'And {n} commit without a pull request.' : 'And {n} commits without a pull request.', { n: shipped.directCommits.length })}</p>}
          {shipped.workItems.length > 0 && (
            <ul className="deploy-list">
              {shipped.workItems.map((w) => (
                <li key={w.id}>
                  <button type="button" className="row-link" onClick={() => openDrawer({ type: 'workitem', id: w.id })}>{w.title}</button>
                  <div className="sub"><TypeLabel type={w.type} /><span className="mono">#{w.id}</span><span>{w.state}</span></div>
                </li>
              ))}
            </ul>
          )}
          <Button size="1" variant="ghost" color="gray" type="button" onClick={() => openDeploy(latest)}>{t('Everything it shipped')} →</Button>
        </section>
      )}

      <section className="detail-section">
        <h3>{t('Timeline')}</h3>
        <ol className="incident-timeline">
          {data.timeline.map((e, i) => (
            <li key={`${e.at}:${i}`} className={e.bad ? 'incident-bad' : undefined}>
              <span className="mono muted small">{dateTime(e.at)}</span>
              <span>{t(e.text, e.params)}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className="detail-section">
        <h3>{t('Go back')}</h3>
        {!data.unlinked && !data.lastGood && <p className="muted small">{t('No earlier successful deploy in the last 90 days to go back to.')}</p>}
        {data.lastGood && <p className="small">{t('The last good release is {label}, deployed {when}.', { label: data.lastGood.label, when: dateTime(data.lastGood.at) })}</p>}
        {plan?.kind === 'release' && can('releases.run') && (
          <Confirm text={t('Redeploy {release} to {stage}? Production goes back to the code it ran before {label}.', { release: plan.label, stage: plan.stage, label: latest?.label || '' })} className="btn btn-small btn-primary" onConfirm={redeploy}>{busy ? t('Deploying…') : t('Redeploy {release}', { release: plan.label })}</Confirm>
        )}
        {plan?.kind === 'manual' && (
          <p className="callout">
            {plan.reason === 'pipeline'
              ? t("Keel doesn't redeploy a pipeline run: running it again builds and deploys with today's pipeline. Run {label}'s deploy again in Azure DevOps.", { label: plan.label })
              : t("{label} is no longer listed with its release pipeline, so Keel can't redeploy it. Do it in Azure DevOps.", { label: plan.label })}
            {plan.webUrl && <> <ExternalLink href={plan.webUrl} /></>}
          </p>
        )}
      </section>

      <section className="detail-actions">
        <Button size="1" variant="outline" color="gray" type="button" onClick={copy}>{t('Copy incident timeline')}</Button>
        <Button size="1" variant="ghost" color="gray" type="button" onClick={() => downloadText(`incident-${m.name}.md`.replace(/[^\w.-]+/g, '-'), markdown())}>{t('Download .md')}</Button>
      </section>
    </div>
  );
}
