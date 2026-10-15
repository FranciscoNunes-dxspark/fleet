import { useState } from 'react';
import { api } from '../api.js';

const SCOPES = [
  ['Code', 'Read & write'],
  ['Work Items', 'Read & write'],
  ['Build', 'Read & execute'],
  ['Release', 'Read, write, execute & manage'],
  ['Project and Team', 'Read'],
  ['Identity', 'Read'],
];

/** Sign in with your own Azure DevOps personal access token. */
export default function SignIn({ orgUrl, reason, onSignedIn }) {
  const [pat, setPat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const org = (orgUrl || '').replace(/^https?:\/\//, '');

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/auth/login', { method: 'POST', body: { pat } });
      setPat('');
      onSignedIn();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="signin">
      <form className="signin-card" onSubmit={submit}>
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <div>
            <div className="brand-name">Lead Console</div>
            <div className="brand-org">{org}</div>
          </div>
        </div>
        <h1>Sign in</h1>
        {reason === 'token-rejected' && <p className="callout small">Azure DevOps stopped accepting your token (it may have expired or been revoked). Paste a new one to continue.</p>}
        {reason === 'signin-required' && <p className="muted small">Your session ended. Sign in again to continue.</p>}
        <p className="signin-lead">
          Use your own Azure DevOps personal access token. Everything you do here, such as votes, approvals and comments, is recorded as you.
        </p>
        <label className="field">Personal access token
          <input
            className="input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={pat}
            onChange={(e) => setPat(e.target.value)}
            placeholder="Paste your token"
            required
            autoFocus
          />
        </label>
        {error && <p className="text-bad small" role="alert">{error}</p>}
        <button type="submit" className="btn btn-primary" disabled={busy || !pat.trim()}>{busy ? 'Checking with Azure DevOps…' : 'Sign in'}</button>

        <details className="signin-help">
          <summary>How to create a token</summary>
          <ol className="small">
            <li>
              Open <a href={`${orgUrl}/_usersSettings/tokens`} target="_blank" rel="noreferrer noopener">Personal access tokens</a> in Azure DevOps
              (your avatar → User settings → Personal access tokens).
            </li>
            <li>Choose <strong>New Token</strong>, pick the organization <strong>{org.split('/').pop()}</strong>, and an expiry you&apos;re comfortable with.</li>
            <li>
              Under <strong>Custom defined</strong>, give these scopes:
              <ul>{SCOPES.map(([s, a]) => <li key={s}>{s}: {a}</li>)}</ul>
              Read-only scopes also work if you only want to look; actions then fail with a clear message.
            </li>
            <li>Create it, copy the token and paste it above.</li>
          </ol>
        </details>
        <p className="muted small signin-foot">
          The token is checked with Azure DevOps, then kept encrypted on this server and only used to act as you. It&apos;s never sent back to your browser.
          Signing out deletes it.
        </p>
      </form>
    </div>
  );
}
