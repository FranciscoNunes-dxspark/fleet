import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useApp } from '../context.js';
import { dateTime } from '../format.js';
import { Pinch } from '../ui.jsx';
import { t, tj } from '../i18n.js';

/**
 * Where `keel login` sends you: type the code your terminal shows, see which terminal asked,
 * and allow it to act as you (server/terminals.js). The code is typed, never taken from the
 * link, so a link someone else sends can't sign their terminal in as you.
 */
export default function TerminalSignIn() {
  const { meta } = useApp();
  const [code, setCode] = useState('');
  const [login, setLogin] = useState(null);
  const [done, setDone] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const run = async (fn) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const check = (e) => {
    e.preventDefault();
    run(async () => setLogin(await api(`/auth/device/${encodeURIComponent(code.trim())}`)));
  };
  const decide = (allow) => run(async () => {
    await api(`/auth/device/${encodeURIComponent(login.userCode)}`, { method: 'POST', body: { allow } });
    setDone(allow ? 'allowed' : 'denied');
  });

  let body;
  if (done) {
    body = (
      <>
        <h1>{done === 'allowed' ? t('Your terminal is signed in') : t('Sign-in refused')}</h1>
        <p className="signin-lead">{done === 'allowed' ? t('Go back to your terminal: Keel starts there in a moment. You can sign it out at any time in Settings → Your account.') : t("That terminal isn't signed in. If you didn't start it, you don't need to do anything else.")}</p>
        <Link to="/" className="btn">{t('Go to the Dashboard')}</Link>
      </>
    );
  } else if (login) {
    body = (
      <>
        <h1>{t('Allow this terminal?')}</h1>
        <dl className="facts">
          <div><dt>{t('Terminal')}</dt><dd>{login.name}</dd></div>
          {login.ip && <div><dt>{t('From')}</dt><dd className="mono">{login.ip}</dd></div>}
          <div><dt>{t('Asked at')}</dt><dd>{dateTime(login.createdAt)}</dd></div>
          <div><dt>{t('Code')}</dt><dd className="mono">{login.userCode}</dd></div>
        </dl>
        <p className="signin-lead">
          {tj('Keel in that terminal will act as {name}, with your role and your Azure DevOps connection: it reads what you can read, and votes, comments, completes pull requests, runs pipelines and approves deployments under your name.', { name: <strong>{meta.account?.name}</strong> })}
        </p>
        {error && <p className="text-bad small" role="alert">{error}</p>}
        <div className="account-actions">
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => decide(true)}>{t('Allow')}</button>
          <button type="button" className="btn" disabled={busy} onClick={() => decide(false)}>{t("Don't allow")}</button>
        </div>
        <p className="muted small">{t("Only allow it if you started keel login yourself, just now, and the code matches your terminal's.")}</p>
      </>
    );
  } else {
    body = (
      <form onSubmit={check} className="terminal-signin-form">
        <h1>{t('Sign in to Keel in the terminal')}</h1>
        <p className="signin-lead">{tj('Type the code {command} shows in your terminal.', { command: <code>keel login</code> })}</p>
        <label className="field">
          {t('Code')}
          <input
            className="input mono"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="WXYZ-BCDF"
            autoComplete="off"
            spellCheck={false}
            maxLength={12}
            autoFocus
            required
          />
        </label>
        {error && <p className="text-bad small" role="alert">{error}</p>}
        <button type="submit" className="btn btn-primary" disabled={busy || code.replace(/[^a-z]/gi, '').length !== 8}>{busy ? t('Checking…') : t('Continue')}</button>
      </form>
    );
  }

  return (
    <div className="page terminal-signin">
      <div className="signin-card">
        <div className="signin-pinch">
          <Pinch width={72} mood={done === 'allowed' ? 'happy' : 'idle'} />
        </div>
        {body}
      </div>
    </div>
  );
}
