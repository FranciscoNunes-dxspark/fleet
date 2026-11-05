import { useState } from 'react';
import { useApi } from '../context.js';
import { dateTime } from '../format.js';
import { Chip, Empty, ErrorBox, ExternalLink, Loading, buttonLook } from '../ui.jsx';
import { t, tx } from '../i18n.js';
import { Button } from '@radix-ui/themes';

const TONE = { critical: 'bad', high: 'bad', medium: 'warn', low: 'info', unknown: 'muted' };
// Labels are getters so they follow the current language.
const SEVERITY = {
  get critical() { return t('Critical'); },
  get high() { return t('High'); },
  get medium() { return t('Medium'); },
  get low() { return t('Low'); },
  get unknown() { return t('Unknown severity'); },
};
const LEVELS = ['critical', 'high', 'medium', 'low'];

/**
 * Insights → Azure DevOps security: what the tracked projects' own settings leave open
 * (server/domain/devopssecurity.js), worst first, each with where to change it. The server reads the
 * settings at most every 5 minutes; Review again reads them now. A secret's value is never sent here:
 * only its variable's name, and what was seen cut down to its first characters.
 */
export default function DevOpsSecurity() {
  const [fresh, setFresh] = useState(0);
  const { data, error, reload, loading } = useApi(`/security/devops${fresh ? `?fresh=1&n=${fresh}` : ''}`);
  const [level, setLevel] = useState('');
  if (!data) return error ? <ErrorBox error={error} onRetry={reload} /> : <Loading />;

  const shown = level ? data.findings.filter((f) => f.severity === level) : data.findings;
  const counts = LEVELS.filter((s) => data.counts[s]);
  return (
    <section aria-busy={loading} className="devops-security">
      <p className="muted small">
        {t("Keel reads each tracked project's settings in Azure DevOps (pipelines and their variables, variable groups, secure files, service connections, branch policies and agent pools) and lists what they leave open, worst first. Read only: it changes nothing.")}
      </p>
      <div className="devops-security-head">
        <span className="chips" role="group" aria-label={t('Severity')}>
          <Button type="button" {...buttonLook(`btn btn-small${level ? ' btn-ghost' : ''}`)} aria-pressed={!level} onClick={() => setLevel('')}>{t('All {n}', { n: data.findings.length })}</Button>
          {counts.map((s) => (
            <Button key={s} type="button" {...buttonLook(`btn btn-small${level === s ? '' : ' btn-ghost'}`)} aria-pressed={level === s} onClick={() => setLevel(level === s ? '' : s)}>
              {SEVERITY[s]} {data.counts[s]}
            </Button>
          ))}
        </span>
        <span className="muted small devops-security-when">
          {t('{n} projects', { n: data.projects.length })} · {t('Reviewed {when}', { when: dateTime(data.at) })}
        </span>
        <Button size="1" variant="outline" color="gray" type="button" disabled={loading} onClick={() => setFresh((n) => n + 1)}>{loading ? t('Reviewing…') : t('Review again')}</Button>
      </div>
      {data.gaps.length > 0 && (
        <div className="small">
          <p className="text-bad">{t('Not reviewed (the token may lack a scope):')}</p>
          <ul>
            {data.gaps.map((g, i) => <li key={i}>{g.projectName ? `${g.projectName}: ` : ''}{tx(g.what)} <span className="muted">({tx(String(g.error).split('\n')[0])})</span></li>)}
          </ul>
        </div>
      )}
      {!data.projects.length && <Empty title={t('No tracked Azure DevOps projects')} />}
      {data.projects.length > 0 && !data.findings.length && <Empty title={t("Nothing found: these projects pass every check Keel makes.")} mood="nap" />}
      {shown.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>{t('Severity')}</th><th>{t('Finding')}</th><th>{t('Where')}</th><th>{t('How to fix it')}</th></tr>
            </thead>
            <tbody>
              {shown.map((f) => (
                <tr key={`${f.org ?? ''}|${f.rule}|${f.where}`}>
                  <td><Chip tone={TONE[f.severity]}>{SEVERITY[f.severity] || f.severity}</Chip></td>
                  <td>
                    <strong>{tx(f.title)}</strong>
                    <div className="small muted">{tx(f.why)}</div>
                    {f.excerpt && <div className="small"><code>{f.excerpt}</code></div>}
                  </td>
                  <td className="small">{f.where}{f.webUrl && <div><ExternalLink href={f.webUrl} /></div>}</td>
                  <td className="small">{tx(f.fix)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
