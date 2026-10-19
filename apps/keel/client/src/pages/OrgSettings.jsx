import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../context.js';
import { t } from '../i18n.js';
import { Chip, Confirm, Loading, Section } from '../ui.jsx';

/**
 * Settings → Organizations. Everyone sees the organizations Keel connects to
 * and, when signing in, links their own token for each; Admins add and remove
 * them. The primary one comes from AZDO_ORG_URL.
 */
export default function OrgSettings() {
  const { authMode, can, toast, refresh } = useApp();
  const login = authMode === 'login';
  const admin = can('users.manage');
  const [orgs, setOrgs] = useState(null);
  const [tokens, setTokens] = useState({});
  const [adding, setAdding] = useState({ url: '', name: '' });
  const [busy, setBusy] = useState(null);

  const load = () => api(login ? '/auth/orgs' : '/orgs').then(setOrgs).catch((e) => toast(e.message, 'bad'));
  useEffect(() => {
    load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (name, fn, ok) => {
    setBusy(name);
    try {
      await fn();
      if (ok) toast(ok);
      await load();
      refresh();
      return true;
    } catch (e) {
      toast(e.message, 'bad');
      return false;
    } finally {
      setBusy(null);
    }
  };

  if (!orgs) return <section className="panel"><Loading /></section>;
  // Nothing to manage with one organization unless you're the one who can add more.
  if (orgs.length < 2 && !admin) return null;

  return (
    <Section id="organizations" title={t('Organizations')}>
      <p className="muted small">
        {login
          ? t('Keel shows every organization you have a token for, together. Link a token for each one, created for that organization: Azure DevOps stops accepting tokens created for "All accessible organizations" on 1 December 2026.')
          : t('Keel shows every organization together, using AZDO_PAT for each, so it must be created for "All accessible organizations", and Azure DevOps stops accepting those on 1 December 2026. To keep several organizations after that, use sign-in (AUTH_MODE=login), where each person links a token per organization.')}
      </p>

      <ul className="org-list">
        {orgs.map((o) => (
          <li key={o.key} className="org-row">
            <div className="org-head">
              <span className="strong">{o.name}</span>
              <a className="small muted" href={o.url} target="_blank" rel="noreferrer noopener">{o.url.replace(/^https?:\/\//, '')}</a>
              {o.primary && <Chip>{t('Primary')}</Chip>}
              {login && (o.connected ? <Chip tone="ok">{t('Connected as {name}', { name: o.azdoName || '…' })}</Chip> : <Chip tone="warn">{t('Not connected')}</Chip>)}
            </div>

            {login && !o.primary && (
              <form
                className="org-token"
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (await run(`token:${o.key}`, () => api('/auth/token', { method: 'POST', body: { pat: tokens[o.key] || '', org: o.key } }), t('Connected to {org}', { org: o.name }))) {
                    setTokens((x) => ({ ...x, [o.key]: '' }));
                  }
                }}
              >
                <input
                  className="input mono"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={tokens[o.key] || ''}
                  onChange={(e) => setTokens((x) => ({ ...x, [o.key]: e.target.value }))}
                  placeholder={o.connected ? t('Paste a new token to replace it') : t('Paste your token for this organization')}
                  aria-label={t('Personal access token for {org}', { org: o.name })}
                />
                <button type="submit" className="btn btn-small" disabled={!tokens[o.key]?.trim() || busy === `token:${o.key}`}>{busy === `token:${o.key}` ? t('Checking…') : o.connected ? t('Replace token') : t('Connect')}</button>
                {o.connected && (
                  <Confirm text={t('Disconnect {org}? Its projects disappear from Keel for you.', { org: o.name })} onConfirm={() => run(`off:${o.key}`, () => api(`/auth/token?org=${encodeURIComponent(o.key)}`, { method: 'DELETE' }), t('Disconnected from {org}', { org: o.name }))} className="btn btn-small btn-ghost">
                    {t('Disconnect')}
                  </Confirm>
                )}
              </form>
            )}
            {login && o.primary && <p className="muted small">{t('Your token for the primary organization is under Your account.')}</p>}

            {admin && !o.primary && (
              <div className="org-admin">
                <Confirm text={t('Remove {org} from Keel for everyone? Tokens people linked for it are kept, in case you add it back.', { org: o.name })} onConfirm={() => run(`rm:${o.key}`, () => api(`/orgs/${encodeURIComponent(o.key)}`, { method: 'DELETE' }), t('{org} removed', { org: o.name }))} className="btn btn-small btn-ghost text-bad">
                  {t('Remove organization')}
                </Confirm>
              </div>
            )}
          </li>
        ))}
      </ul>

      {admin && (
        <form
          className="org-add"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await run('add', () => api('/orgs', { method: 'POST', body: adding }), t('Organization added. Link a token for it, then pick its projects below.'))) setAdding({ url: '', name: '' });
          }}
        >
          <h3 className="small">{t('Add an organization')}</h3>
          <div className="org-add-row">
            <label>{t('Address')}<input className="input" value={adding.url} onChange={(e) => setAdding({ ...adding, url: e.target.value })} placeholder="https://dev.azure.com/other-org" inputMode="url" required /></label>
            <label><span>{t('Name')} <span className="muted small">{t('(optional)')}</span></span><input className="input" value={adding.name} onChange={(e) => setAdding({ ...adding, name: e.target.value })} placeholder={t('As your team calls it')} /></label>
            <button type="submit" className="btn btn-small btn-primary" disabled={!adding.url.trim() || busy === 'add'}>{busy === 'add' ? t('Adding…') : t('Add organization')}</button>
          </div>
        </form>
      )}
    </Section>
  );
}
