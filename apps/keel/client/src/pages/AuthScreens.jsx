import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Loading, Logo } from '../ui.jsx';

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
            <div className="brand-name">Shipdeck</div>
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
    <Card orgUrl={orgUrl} title="Sign in" onSubmit={submit}>
      {reason === 'signin-required' && <p className="muted small">Your session ended. Sign in again to continue.</p>}
      <Field label="Email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
      <Field label="Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
      {error && <p className="text-bad small" role="alert">{error}</p>}
      <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      <p className="muted small signin-foot">No account yet? Ask your Shipdeck admin for an invite link. Forgot your password? Your admin can send you a reset link.</p>
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
    <Card orgUrl={orgUrl} title="Set up Shipdeck" onSubmit={submit}>
      <p className="signin-lead">Create the admin account. You&apos;ll invite everyone else from the Users page afterwards.</p>
      <Field label="Setup code" hint="(printed in the server log when Shipdeck starts)" value={form.code} onChange={set('code')} autoComplete="off" spellCheck={false} required autoFocus />
      <Field label="Your name" value={form.name} onChange={set('name')} autoComplete="name" required />
      <Field label="Email" type="email" value={form.email} onChange={set('email')} autoComplete="username" required />
      <Field label="Password" hint="(at least 10 characters)" type="password" value={form.password} onChange={set('password')} autoComplete="new-password" minLength={10} required />
      {error && <p className="text-bad small" role="alert">{error}</p>}
      <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Creating…' : 'Create admin account'}</button>
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
      <Card orgUrl={orgUrl} title="Link not valid" onSubmit={(e) => { e.preventDefault(); onDone(); }}>
        <p className="text-bad small">{loadError}</p>
        <button type="submit" className="btn">Go to sign in</button>
      </Card>
    );
  }
  if (!info) return <div className="boot"><Loading /></div>;
  const reset = info.purpose === 'reset';
  return (
    <Card orgUrl={orgUrl} title={reset ? 'Choose a new password' : 'Welcome to Shipdeck'} onSubmit={submit}>
      <p className="signin-lead">
        {reset ? <>Set a new password for <strong>{info.email}</strong>. You&apos;ll be signed out on other devices.</>
          : <>You&apos;ve been invited as <strong>{ROLE[info.role]}</strong> with <strong>{info.email}</strong>. Choose your password to finish.</>}
      </p>
      {!reset && <Field label="Your name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required />}
      <Field label="Password" hint="(at least 10 characters)" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={10} required autoFocus />
      {error && <p className="text-bad small" role="alert">{error}</p>}
      <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : reset ? 'Save password' : 'Create my account'}</button>
    </Card>
  );
}

/** Link (or re-link) this account to Azure DevOps with the person's own token. */
export function ConnectAzure({ orgUrl, user, reason, onDone, onSignOut }) {
  const [pat, setPat] = useState('');
  const org = (orgUrl || '').replace(/^https?:\/\//, '');
  const { busy, error, submit } = useSubmit(async () => {
    await api('/auth/token', { method: 'POST', body: { pat } });
    setPat('');
    onDone();
  });
  return (
    <Card orgUrl={orgUrl} title="Connect Azure DevOps" onSubmit={submit}>
      {reason === 'token-rejected' && <p className="callout small">Azure DevOps stopped accepting your token (it may have expired or been revoked). Paste a new one to continue.</p>}
      <p className="signin-lead">
        Hi {user?.name?.split(' ')[0] || 'there'}. Link your own Azure DevOps personal access token. What you do in Shipdeck, such as votes, approvals and comments, is recorded under your name.
      </p>
      <Field label="Personal access token" type="password" autoComplete="off" spellCheck={false} value={pat} onChange={(e) => setPat(e.target.value)} placeholder="Paste your token" required autoFocus />
      {error && <p className="text-bad small" role="alert">{error}</p>}
      <button type="submit" className="btn btn-primary" disabled={busy || !pat.trim()}>{busy ? 'Checking with Azure DevOps…' : 'Connect'}</button>
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
          </li>
          <li>Create it, copy the token and paste it above.</li>
        </ol>
      </details>
      <p className="muted small signin-foot">
        The token is checked with Azure DevOps, then kept encrypted on this server and only used to act as you. It&apos;s never sent back to your browser.
        {' '}<button type="button" className="link-btn" onClick={onSignOut}>Sign out</button>
      </p>
    </Card>
  );
}
