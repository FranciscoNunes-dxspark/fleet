import { useState } from 'react';
import { api } from '../api.js';
import { useApi, useApp } from '../context.js';
import { age, date } from '../format.js';
import { Avatar, Chip, Confirm, Empty, ErrorBox, Loading, PageHeader } from '../ui.jsx';
import { t } from '../i18n.js';

// Role names stay as they are in every language; hints and status labels are getters so they follow it.
const ROLES = [
  { id: 'admin', label: 'Admin', get hint() { return t('Everything, including users and production monitors'); } },
  { id: 'developer', label: 'Developer', get hint() { return t('All Azure DevOps actions: pull requests, work items, pipelines, approvals'); } },
  { id: 'pm', label: 'PM', get hint() { return t('Work items and boards, approvals, running pipelines and releases. No pull request actions.'); } },
];
const STATUS = {
  active: { tone: 'ok', get label() { return t('Active'); } },
  invited: { tone: 'info', get label() { return t('Invited'); } },
  disabled: { tone: 'muted', get label() { return t('Disabled'); } },
};

/** Admin only: who can use Keel, and as what. */
export default function Users() {
  const { meta, can, toast } = useApp();
  const { data, error, reload } = useApi(can('users.manage') ? '/admin/users' : null);
  const [form, setForm] = useState({ email: '', name: '', role: 'developer' });
  const [link, setLink] = useState(null); // { label, url }
  const [busy, setBusy] = useState(false);

  if (!can('users.manage')) {
    return <div className="page"><PageHeader title={t('Users')} /><Empty title={t('Only admins can manage users.')} /></div>;
  }
  if (!data) return error ? <ErrorBox error={error} onRetry={reload} /> : <Loading />;

  const run = async (fn, okMessage) => {
    setBusy(true);
    try {
      const r = await fn();
      if (okMessage) toast(okMessage);
      reload();
      return r;
    } catch (e) {
      toast(e.message, 'bad');
      return null;
    } finally {
      setBusy(false);
    }
  };

  const invite = async (e) => {
    e.preventDefault();
    const r = await run(() => api('/admin/users', { method: 'POST', body: form }), null);
    if (r) {
      setLink({ label: t('Invite for {email}', { email: r.user.email }), url: r.link });
      setForm({ email: '', name: '', role: form.role });
    }
  };

  const copy = async (url) => {
    try {
      await navigator.clipboard.writeText(url);
      toast(t('Link copied'));
    } catch {
      toast(t('Copy failed. Select the link and copy it manually.'), 'bad');
    }
  };

  const meId = meta.account?.id;

  return (
    <div className="page">
      <PageHeader title={t('Users')} sub={t('Invite people, choose what they can do, and manage access. Everyone signs in with their own password and links their own Azure DevOps token.')} />

      <form className="panel invite-form" onSubmit={invite}>
        <h2 className="section-title">{t('Invite someone')}</h2>
        <div className="form-row">
          <label>{t('Email')}<input className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required /></label>
          <label>{t('Name')}<input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t('Optional')} /></label>
          <label>{t('Role')}
            <select className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              {ROLES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            </select>
          </label>
          <button type="submit" className="btn btn-primary" disabled={busy}>{t('Create invite link')}</button>
        </div>
        <p className="muted small">{t("{hint}. Keel doesn't send email: copy the link and send it yourself. It works once and expires in 7 days.", { hint: ROLES.find((r) => r.id === form.role).hint })}</p>
      </form>

      {link && (
        <div className="panel link-panel" role="status">
          <strong>{link.label}</strong>
          <div className="link-row">
            <input className="input mono" readOnly value={link.url} onFocus={(e) => e.target.select()} aria-label={t('Link to send')} />
            <button type="button" className="btn btn-small" onClick={() => copy(link.url)}>{t('Copy')}</button>
            <button type="button" className="btn btn-small btn-ghost" onClick={() => setLink(null)}>{t('Done')}</button>
          </div>
        </div>
      )}

      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>{t('Person')}</th><th>{t('Role')}</th><th>{t('Status')}</th><th>Azure DevOps</th><th>{t('Last seen')}</th><th><span className="sr-only">{t('Actions')}</span></th></tr></thead>
          <tbody>
            {data.users.map((u) => (
              <tr key={u.id}>
                <td>
                  <span className="person"><Avatar person={{ displayName: u.name }} size={24} /> <span><span className="strong">{u.name}</span>{u.id === meId && <span className="muted small"> {t('(you)')}</span>}<div className="muted small">{u.email}</div></span></span>
                </td>
                <td>
                  <select
                    className="input input-inline"
                    value={u.role}
                    disabled={busy}
                    onChange={(e) => run(() => api(`/admin/users/${u.id}`, { method: 'PATCH', body: { role: e.target.value } }), t('{name} is now {role}', { name: u.name, role: ROLES.find((r) => r.id === e.target.value).label }))}
                    aria-label={t('Role for {name}', { name: u.name })}
                  >
                    {ROLES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                  </select>
                </td>
                <td>
                  <Chip tone={STATUS[u.status].tone}>{STATUS[u.status].label}</Chip>
                  {u.status === 'invited' && u.inviteExpiresAt && <div className="muted small">{Date.parse(u.inviteExpiresAt) < Date.now() ? t('Invite expired') : t('Link valid until {date}', { date: date(u.inviteExpiresAt) })}</div>}
                </td>
                <td className="small">{u.hasToken ? (u.azdoName ? t('Connected as {name}', { name: u.azdoName }) : t('Connected')) : <span className="muted">{t('Not connected')}</span>}</td>
                <td className="small muted">{u.lastSeenAt ? t('{age} ago', { age: age(u.lastSeenAt) }) : '—'}</td>
                <td className="row-actions">
                  <button
                    type="button"
                    className="btn btn-small btn-ghost"
                    disabled={busy}
                    onClick={async () => {
                      const r = await run(() => api(`/admin/users/${u.id}/link`, { method: 'POST' }), null);
                      if (r) setLink({ label: u.status === 'invited' ? t('New invite for {email}', { email: u.email }) : t('Password reset for {email}', { email: u.email }), url: r.link });
                    }}
                  >
                    {u.status === 'invited' ? t('New invite link') : t('Reset password')}
                  </button>
                  {u.id !== meId && (u.status === 'disabled'
                    ? <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={() => run(() => api(`/admin/users/${u.id}`, { method: 'PATCH', body: { disabled: false } }), t('{name} enabled', { name: u.name }))}>{t('Enable')}</button>
                    : <Confirm text={t("Disable {name}? They're signed out right away.", { name: u.name })} onConfirm={() => run(() => api(`/admin/users/${u.id}`, { method: 'PATCH', body: { disabled: true } }), t('{name} disabled', { name: u.name }))} className="btn btn-small btn-ghost">{t('Disable')}</Confirm>)}
                  {u.id !== meId && (
                    <Confirm text={t("Remove {name} and their settings? This can't be undone.", { name: u.name })} onConfirm={() => run(() => api(`/admin/users/${u.id}`, { method: 'DELETE' }), t('{name} removed', { name: u.name }))} className="btn btn-small btn-ghost text-bad">{t('Remove')}</Confirm>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
