import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Loading, Logo } from '../ui.jsx';
import { t, tj } from '../i18n.js';

// Scope names and access levels as Azure DevOps shows them on its token page (kept in English).
const SCOPES = [
  ['Code', 'Read & write'],
  ['Work Items', 'Read & write'],
  ['Build', 'Read & execute'],
  ['Release', 'Read, write, execute & manage'],
  ['Project and Team', 'Read'],
  ['Identity', 'Read'],
];
const ROLE = { admin: 'Admin', developer: 'Developer', pm: 'PM' };

function Card({ orgUrl, title, children, onSubmit }) {
  const org = (orgUrl || '').replace(/^https?:\/\//, '');
  return (
    <div className="signin">
      <form className="signin-card" onSubmit={onSubmit}>
        <div className="brand">
          <Logo size={32} />
          <div>
            <div className="brand-name">Keel</div>
            <div className="brand-org">{org}</div>
          </div>
        </div>
        <h1>{title}</h1>
        {children}
      </form>
    </div>
  );
}

function useSubmit(fn) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, submit };
}

const Field = ({ label, hint, ...props }) => (
  <label className="field">{label}{hint && <span className="muted small"> {hint}</span>}<input className="input" {...props} /></label>
);

/** Email + password. */
export function SignIn({ orgUrl, reason, onDone }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { busy, error, submit } = useSubmit(async () => {
    await api('/auth/login', { method: 'POST', body: { email, password } });
    setPassword('');
    onDone();
  });
  return (
    <Card orgUrl={orgUrl} title={t('Sign in')} onSubmit={submit}>
      {reason === 'signin-required' && <p className="muted small">{t('Your session ended. Sign in again to continue.')}</p>}
      <Field label={t('Email')} type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
      <Field label={t('Password')} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
      {error && <p className="text-bad small" role="alert">{error}</p>}
      <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? t('Signing in…') : t('Sign in')}</button>
      <p className="muted small signin-foot">{t('No account yet? Ask your Keel admin for an invite link. Forgot your password? Your admin can send you a reset link.')}</p>
    </Card>
  );
}

/** First run: create the admin account with the setup code from the server log. */
export function SetupScreen({ orgUrl, onDone }) {
  const [form, setForm] = useState({ code: '', name: '', email: '', password: '' });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const { busy, error, submit } = useSubmit(async () => {
    await api('/auth/setup', { method: 'POST', body: form });
    onDone();
  });
  return (
    <Card orgUrl={orgUrl} title={t('Set up Keel')} onSubmit={submit}>
      <p className="signin-lead">{t("Create the admin account. You'll invite everyone else from the Users page afterwards.")}</p>
      <Field label={t('Setup code')} hint={t('(printed in the server log when Keel starts)')} value={form.code} onChange={set('code')} autoComplete="off" spellCheck={false} required autoFocus />
      <Field label={t('Your name')} value={form.name} onChange={set('name')} autoComplete="name" required />
      <Field label={t('Email')} type="email" value={form.email} onChange={set('email')} autoComplete="username" required />
      <Field label={t('Password')} hint={t('(at least 10 characters)')} type="password" value={form.password} onChange={set('password')} autoComplete="new-password" minLength={10} required />
      {error && <p className="text-bad small" role="alert">{error}</p>}
      <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? t('Creating…') : t('Create admin account')}</button>
    </Card>
  );
}

/** Invite or password-reset link: choose a password. */
export function LinkAccept({ orgUrl, token, onDone }) {
  const [info, setInfo] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  useEffect(() => {
    api(`/auth/link/${encodeURIComponent(token)}`)
      .then((d) => { setInfo(d); setName(d.name || ''); })
      .catch((e) => setLoadError(e.message));
  }, [token]);
  const { busy, error, submit } = useSubmit(async () => {
    await api(`/auth/link/${encodeURIComponent(token)}`, { method: 'POST', body: { name, password } });
    onDone();
  });
  if (loadError) {
    return (
      <Card orgUrl={orgUrl} title={t('Link not valid')} onSubmit={(e) => { e.preventDefault(); onDone(); }}>
        <p className="text-bad small">{loadError}</p>
        <button type="submit" className="btn">{t('Go to sign in')}</button>
      </Card>
    );
  }
  if (!info) return <div className="boot"><Loading /></div>;
  const reset = info.purpose === 'reset';
  return (
    <Card orgUrl={orgUrl} title={reset ? t('Choose a new password') : t('Welcome to Keel')} onSubmit={submit}>
      <p className="signin-lead">
        {reset ? tj("Set a new password for {email}. You'll be signed out on other devices.", { email: <strong>{info.email}</strong> })
          : tj("You've been invited as {role} with {email}. Choose your password to finish.", { role: <strong>{ROLE[info.role]}</strong>, email: <strong>{info.email}</strong> })}
      </p>
      {!reset && <Field label={t('Your name')} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required />}
      <Field label={t('Password')} hint={t('(at least 10 characters)')} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={10} required autoFocus />
      {error && <p className="text-bad small" role="alert">{error}</p>}
      <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? t('Saving…') : reset ? t('Save password') : t('Create my account')}</button>
    </Card>
  );
}

/** Link (or re-link) this account to Azure DevOps with the person's own token. */
export function ConnectAzure({ orgUrl, user, reason, onDone, onSignOut }) {
  const [pat, setPat] = useState('');
  const org = (orgUrl || '').replace(/^https?:\/\//, '');
  const first = user?.name?.split(' ')[0];
  const { busy, error, submit } = useSubmit(async () => {
    await api('/auth/token', { method: 'POST', body: { pat } });
    setPat('');
    onDone();
  });
  return (
    <Card orgUrl={orgUrl} title={t('Connect Azure DevOps')} onSubmit={submit}>
      {reason === 'token-rejected' && <p className="callout small">{t('Azure DevOps stopped accepting your token (it may have expired or been revoked). Paste a new one to continue.')}</p>}
      <p className="signin-lead">
        {first ? t('Hi {name}.', { name: first }) : t('Hi there.')}
        {' '}{t('Link your own Azure DevOps personal access token. What you do in Keel, such as votes, approvals and comments, is recorded under your name.')}
      </p>
      <Field label={t('Personal access token')} type="password" autoComplete="off" spellCheck={false} value={pat} onChange={(e) => setPat(e.target.value)} placeholder={t('Paste your token')} required autoFocus />
      {error && <p className="text-bad small" role="alert">{error}</p>}
      <button type="submit" className="btn btn-primary" disabled={busy || !pat.trim()}>{busy ? t('Checking with Azure DevOps…') : t('Connect')}</button>
      <details className="signin-help">
        <summary>{t('How to create a token')}</summary>
        <ol className="small">
          <li>
            {tj('Open {link} in Azure DevOps (your avatar → User settings → Personal access tokens).', {
              link: <a href={`${orgUrl}/_usersSettings/tokens`} target="_blank" rel="noreferrer noopener">Personal access tokens</a>,
            })}
          </li>
          <li>{tj("Choose {newToken}, pick the organization {org}, and an expiry you're comfortable with.", { newToken: <strong>New Token</strong>, org: <strong>{org.split('/').pop()}</strong> })}</li>
          <li>
            {tj('Under {custom}, give these scopes:', { custom: <strong>Custom defined</strong> })}
            <ul>{SCOPES.map(([s, a]) => <li key={s}>{s}: {a}</li>)}</ul>
          </li>
          <li>{t('Create it, copy the token and paste it above.')}</li>
        </ol>
      </details>
      <p className="muted small signin-foot">
        {t("The token is checked with Azure DevOps, then kept encrypted on this server and only used to act as you. It's never sent back to your browser.")}
        {' '}<button type="button" className="link-btn" onClick={onSignOut}>{t('Sign out')}</button>
      </p>
    </Card>
  );
}
