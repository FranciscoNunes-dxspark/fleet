import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useApi, useApp } from '../context.js';
import { dateTime } from '../format.js';
import { Chip, Empty, ErrorBox, ExternalLink, Loading } from '../ui.jsx';
import { t, tx } from '../i18n.js';
import { Button } from '@radix-ui/themes';

const RANK = { critical: 0, high: 1, medium: 2, low: 3, unknown: 4 };
const TONE = { critical: 'bad', high: 'bad', medium: 'warn', low: 'info', unknown: 'muted' };
// Labels are getters so they follow the current language.
const SEVERITY = {
  get critical() { return t('Critical'); },
  get high() { return t('High'); },
  get medium() { return t('Medium'); },
  get low() { return t('Low'); },
  get unknown() { return t('Unknown severity'); },
};
const worst = (r) => (r.advisories.length ? RANK[r.advisories[0].severity] ?? 4 : 9);

/**
 * The advisory watch's findings (server/advisories.js): each tracked repository's advisories in
 * the lock files on its default branch, worst first, with when it was last read and Check now.
 */
export default function Advisories() {
  const { data, error, reload, loading } = useApi('/advisories');
  const [checking, setChecking] = useState(null);
  const { toast, refresh } = useApp();
  if (!data) return error ? <ErrorBox error={error} onRetry={reload} /> : <Loading />;

  const repos = [...data.repos].sort((a, b) => worst(a) - worst(b) || b.advisories.length - a.advisories.length || a.repoName.localeCompare(b.repoName));
  const total = repos.reduce((n, r) => n + r.advisories.length, 0);

  const check = async (r) => {
    const key = `${r.projectId}/${r.repoId}`;
    setChecking(key);
    try {
      await api('/advisories/check', { method: 'POST', body: { projectId: r.projectId, repoId: r.repoId } });
      toast(t('{repo} checked', { repo: r.repoName }));
      refresh();
    } catch (e) {
      toast(tx(e.message), 'bad');
    } finally {
      setChecking(null);
    }
  };

  return (
    <section aria-busy={loading} className="advisories">
      <p className="muted small">
        {!data.available ? t('The advisory watch runs on the Keel server, so this computer has no findings of its own.')
          : !data.enabled ? <>{t('The advisory watch is off for you.')} <Link to="/settings#advisories">{t('Turn it on in Settings')}</Link></>
            : t("Once a day Keel reads the npm and NuGet lock files on each repository's default branch and asks osv.dev about their packages. New advisories go to your inbox; the first look at a repository only records what's there.")}
      </p>
      {!repos.length && <Empty title={t('No tracked repositories')} />}
      {repos.length > 0 && total === 0 && repos.some((r) => r.checkedAt) && <p className="small">{t('No known advisories in the lock files read so far.')}</p>}
      {repos.map((r) => {
        const key = `${r.projectId}/${r.repoId}`;
        return (
          <div key={key} className="advisory-repo">
            <div className="advisory-head">
              <strong>{r.repoName}</strong>
              <span className="muted small">{r.projectName}{r.defaultBranch ? ` · ${r.defaultBranch}` : ''}</span>
              {r.advisories.length > 0 && <Chip tone={TONE[r.advisories[0].severity]}>{t(r.advisories.length === 1 ? '1 advisory' : '{n} advisories', { n: r.advisories.length })}</Chip>}
              <span className="muted small advisory-when">
                {r.checkedAt ? t('Checked {when}', { when: dateTime(r.checkedAt) }) : r.triedAt ? t('Not read yet') : t('Not checked yet')}
                {r.checkedAt && ` · ${r.lockFiles.length ? t(r.lockFiles.length === 1 ? '1 lock file, {n} packages' : '{files} lock files, {n} packages', { files: r.lockFiles.length, n: r.packages ?? 0 }) : t('No lock files')}`}
              </span>
              {data.available && data.enabled && (
                <Button size="1" variant="outline" color="gray" type="button" disabled={!!checking || !r.defaultBranch} onClick={() => check(r)}>
                  {checking === key ? t('Checking…') : t('Check now')}
                </Button>
              )}
            </div>
            {r.error && <p className="text-bad small">{t("Couldn't check it: {error}", { error: tx(r.error) })}</p>}
            {r.unreadable.length > 0 && <p className="muted small">{t("Couldn't read: {files}", { files: r.unreadable.join(', ') })}</p>}
            {r.moreLockFiles && <p className="muted small">{t('Only the first 50 lock files are read.')}</p>}
            {r.advisories.length > 0 && (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr><th>{t('Severity')}</th><th>{t('Package')}</th><th>{t('Advisory')}</th><th>{t('Fixed in')}</th><th>{t('Lock file')}</th><th>{t('First seen')}</th></tr>
                  </thead>
                  <tbody>
                    {r.advisories.map((a) => (
                      <tr key={`${a.id}:${a.package}@${a.version}`}>
                        <td><Chip tone={TONE[a.severity]}>{SEVERITY[a.severity] || a.severity}{a.score != null ? ` ${a.score}` : ''}</Chip></td>
                        <td><code>{a.package}</code> {a.version}{a.direct ? '' : <span className="muted small"> {t('(indirect)')}</span>}</td>
                        <td><ExternalLink href={`https://osv.dev/vulnerability/${encodeURIComponent(a.id)}`} className="">{a.id}</ExternalLink><div className="small muted">{a.summary}</div></td>
                        <td>{a.fixed || <span className="muted">{t('No fix yet')}</span>}</td>
                        <td className="small"><code>{a.path}</code></td>
                        <td className="small">{dateTime(a.firstSeen)}{a.baseline && <div className="muted">{t('first look')}</div>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}
