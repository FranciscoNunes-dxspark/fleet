import { Link } from 'react-router-dom';
import { useApi, useApp } from '../context.js';
import { age, dateTime } from '../format.js';
import { Chip, Empty, ErrorBox, ExternalLink, Loading, PageHeader, ProductionTabs } from '../ui.jsx';
import { t, tx } from '../i18n.js';
import { useProjectLabel } from '../orgs.js';
import { ChangeSections } from './DeployDetail.jsx';

const DAY = 86_400_000;

/** Waiting longer than this reads as a warning: the change is done but users don't have it. */
export const LONG_WAIT_DAYS = 7;

/** How long the oldest change has waited, as a tone for chips and numbers. */
export const waitTone = (oldestAt) => (!oldestAt ? 'ok' : Date.now() - Date.parse(oldestAt) > LONG_WAIT_DAYS * DAY ? 'warn' : 'info');

/** Environments whose waiting can't be counted (not linked, not comparable, unreadable). */
export const uncounted = (e) => !!(e.error || e.unknown || e.unlinked || e.diverged);

/** Environments with the most waiting (the oldest change first), then the up-to-date ones, then those that can't be counted. */
export const byWaiting = (a, b) => uncounted(a) - uncounted(b)
  || (Date.parse(a.oldestAt) || Infinity) - (Date.parse(b.oldestAt) || Infinity) || a.name.localeCompare(b.name);

/**
 * What's merged but not in production yet: for each production environment,
 * the commits on its branch since the last successful deploy, grouped into
 * pull requests and work items. Answers "is my fix live?" and "what goes out
 * with the next deploy?".
 */
export default function Shipping() {
  const { data, error, reload } = useApi('/deploys/pending');
  return (
    <div className="page page-wide">
      <PageHeader title={t('Production')} sub={t("What's merged but not deployed yet, per production environment.")} />
      <ProductionTabs />
      {!data ? (error ? <ErrorBox error={error} onRetry={reload} /> : <Loading />) : !data.targets.length ? (
        <Empty title={t('No production environment found.')}>
          {t('Link a production monitor to the release stage or pipeline that deploys it, or name the classic release stage "Production".')}
          {' '}<Link to="/settings#production">{t('Settings → Production monitors')}</Link>
        </Empty>
      ) : (
        <div className="monitor-list">
          {[...data.targets].sort(byWaiting).map((env) => <Environment key={`${env.org || ''}:${env.key}`} env={env} />)}
        </div>
      )}
    </div>
  );
}

function Environment({ env }) {
  const { openDrawer, can } = useApp();
  const projectLabel = useProjectLabel();
  // Changes, as the server counts them: each merged PR once, plus commits pushed without one.
  const waiting = env.waiting ?? 0;
  const last = env.lastDeploy;
  const openDeploy = () => openDrawer({ type: 'deploy', projectId: env.projectId, target: env.key, id: last.id, org: env.org });

  let chip;
  if (env.error) chip = <Chip tone="bad">{t("Couldn't read")}</Chip>;
  else if (env.unlinked) chip = <Chip tone="muted">{t('Not linked')}</Chip>;
  else if (env.diverged) chip = <Chip tone="warn">{t("Can't compare")}</Chip>;
  else if (env.unknown) chip = <Chip tone="muted">{t('Unknown')}</Chip>;
  else if (!waiting) chip = <Chip tone="ok">{t('Up to date')}</Chip>;
  else chip = <Chip tone={waitTone(env.oldestAt)}>{t(waiting === 1 ? '{n} change waiting' : '{n} changes waiting', { n: waiting })}{env.truncated ? '+' : ''}</Chip>;

  return (
    <section className={`panel monitor ship-env ${env.error ? 'monitor-down' : uncounted(env) ? '' : !waiting ? 'monitor-up' : waitTone(env.oldestAt) === 'warn' ? 'monitor-degraded' : 'monitor-deploying'}`} aria-label={env.name}>
      <header className="monitor-head">
        <div>
          <h2>{env.name}</h2>
          <div className="small muted">{[projectLabel(env.projectName, env.org), env.repo?.name, env.branch].filter(Boolean).join(' · ')}</div>
        </div>
        {chip}
      </header>

      {env.error && <p className="callout callout-bad">{tx(env.error)}</p>}
      {env.unlinked && (
        <p className="muted small">
          {t("This monitor isn't linked to the release stage or pipeline that deploys it, so Keel can't tell what's live.")}
          {can('monitors.manage') && <> <Link to="/settings#production">{t('Link it in Settings → Production monitors')}</Link></>}
        </p>
      )}
      {env.diverged && (
        <p className="callout">
          {env.deployedBranch && env.deployedBranch !== env.branch
            ? t("Production runs a build from {deployed}, which isn't on {branch}, so what's waiting can't be counted.", { deployed: env.deployedBranch, branch: env.branch })
            : t("Production runs a commit that isn't on {branch} (built from another branch, or the branch was rewritten), so what's waiting can't be counted.", { branch: env.branch })}
        </p>
      )}
      {env.unknown && (
        <p className="muted small">
          {env.untracked
            ? t("The last deploy shipped a repository you don't track, so what's waiting can't be listed.")
            : t('No successful deploy with a known commit in the last 90 days.')}
        </p>
      )}

      {last && !env.error && !env.diverged && (
        <dl className="fact-row monitor-facts">
          <div className="fact">
            <dt>{t('Last deploy')}</dt>
            <dd><button type="button" className="link-btn" onClick={openDeploy} title={t('What this deploy shipped')}>{last.label}</button></dd>
            <dd className="muted small" title={dateTime(last.at)}>{t('{age} ago', { age: age(last.at) })}{last.by ? ` · ${last.by}` : ''}</dd>
          </div>
          {!env.unknown && <>
            <div className="fact">
              <dt>{t('Waiting')}</dt>
              <dd>{waiting}</dd>
              <dd className="muted small">
                {[
                  env.pullRequests.length && t(env.pullRequests.length === 1 ? '{n} pull request' : '{n} pull requests', { n: env.pullRequests.length }),
                  env.directCommits.length && t(env.directCommits.length === 1 ? '{n} commit without a pull request' : '{n} commits without a pull request', { n: env.directCommits.length }),
                ].filter(Boolean).join(' · ') || t('nothing waiting')}
              </dd>
            </div>
            <div className="fact">
              <dt>{t('Oldest change')}</dt>
              <dd className={waitTone(env.oldestAt) === 'warn' ? 'text-warn' : ''}>{env.oldestAt ? age(env.oldestAt) : '—'}</dd>
              <dd className="muted small">{env.oldestAt ? t('since it was merged') : t('nothing waiting')}</dd>
            </div>
          </>}
        </dl>
      )}

      {waiting > 0 && (
        <details className="ship-changes" open={waiting <= 12}>
          <summary className="small">{t('What goes out with the next deploy')}{env.authors?.length ? <span className="muted"> · {env.authors.join(', ')}</span> : null}</summary>
          <ChangeSections changes={env} org={env.org} />
        </details>
      )}
      {last?.webUrl && <div className="ship-foot"><ExternalLink href={last.webUrl}>{t('Last deploy in Azure DevOps')}</ExternalLink></div>}
    </section>
  );
}
