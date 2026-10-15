import { useState } from 'react';
import { api } from '../api.js';
import { useApi, useApp } from '../context.js';
import { age, date } from '../format.js';
import { Avatar, Chip, Confirm, Empty, ErrorBox, Loading, PageHeader } from '../ui.jsx';

const ROLES = [
  { id: 'admin', label: 'Admin', hint: 'Everything, including users and production monitors' },
  { id: 'developer', label: 'Developer', hint: 'All Azure DevOps actions: pull requests, work items, pipelines, approvals' },
  { id: 'pm', label: 'PM', hint: 'Work items and boards, approvals, running pipelines and releases. No pull request actions.' },
];
const STATUS = { active: { tone: 'ok', label: 'Active' }, invited: { tone: 'info', label: 'Invited' }, disabled: { tone: 'muted', label: 'Disabled' } };

/** Admin only: who can use this Shipdeck, and as what. */
export default function Users() {
  const { meta, can, toast } = useApp();
  const { data, error, reload } = useApi(can('users.manage') ? '/admin/users' : null);
  const [form, setForm] = useState({ email: '', name: '', role: 'developer' });
  const [link, setLink] = useState(null); // { label, url }
  const [busy, setBusy] = useState(false);

  if (!can('users.manage')) {
    return <div className="page"><PageHeader title="Users" /><Empty title="Only admins can manage users." /></div>;
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
      setLink({ label: `Invite for ${r.user.email}`, url: r.link });
      setForm({ email: '', name: '', role: form.role });
    }
  };

  const copy = async (url) => {
    try {
      await navigator.clipboard.writeText(url);
      toast('Link copied');
    } catch {
      toast('Copy failed. Select the link and copy it manually.', 'bad');
    }
  };

  const meId = meta.account?.id;

  return (
    <div className="page">
      <PageHeader title="Users" sub="Invite people, choose what they can do, and manage access. Everyone signs in with their own password and links their own Azure DevOps token." />

      <form className="panel invite-form" onSubmit={invite}>
        <h2 className="section-title">Invite someone</h2>
        <div className="form-row">
          <label>Email<input className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required /></label>
          <label>Name<input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Optional" /></label>
          <label>Role
            <select className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              {ROLES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            </select>
          </label>
          <button type="submit" className="btn btn-primary" disabled={busy}>Create invite link</button>
        </div>
        <p className="muted small">{ROLES.find((r) => r.id === form.role).hint}. Shipdeck doesn&apos;t send email: copy the link and send it yourself. It works once and expires in 7 days.</p>
      </form>

      {link && (
        <div className="panel link-panel" role="status">
          <strong>{link.label}</strong>
          <div className="link-row">
            <input className="input mono" readOnly value={link.url} onFocus={(e) => e.target.select()} aria-label="Link to send" />
            <button type="button" className="btn btn-small" onClick={() => copy(link.url)}>Copy</button>
            <button type="button" className="btn btn-small btn-ghost" onClick={() => setLink(null)}>Done</button>
          </div>
        </div>
      )}

      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Person</th><th>Role</th><th>Status</th><th>Azure DevOps</th><th>Last seen</th><th><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {data.users.map((u) => (
              <tr key={u.id}>
                <td>
                  <span className="person"><Avatar person={{ displayName: u.name }} size={24} /> <span><span className="strong">{u.name}</span>{u.id === meId && <span className="muted small"> (you)</span>}<div className="muted small">{u.email}</div></span></span>
                </td>
                <td>
                  <select
                    className="input input-inline"
                    value={u.role}
                    disabled={busy}
                    onChange={(e) => run(() => api(`/admin/users/${u.id}`, { method: 'PATCH', body: { role: e.target.value } }), `${u.name} is now ${ROLES.find((r) => r.id === e.target.value).label}`)}
                    aria-label={`Role for ${u.name}`}
                  >
                    {ROLES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                  </select>
                </td>
                <td>
                  <Chip tone={STATUS[u.status].tone}>{STATUS[u.status].label}</Chip>
                  {u.status === 'invited' && u.inviteExpiresAt && <div className="muted small">{Date.parse(u.inviteExpiresAt) < Date.now() ? 'Invite expired' : `Link valid until ${date(u.inviteExpiresAt)}`}</div>}
                </td>
                <td className="small">{u.hasToken ? <>Connected{u.azdoName ? ` as ${u.azdoName}` : ''}</> : <span className="muted">Not connected</span>}</td>
                <td className="small muted">{u.lastSeenAt ? `${age(u.lastSeenAt)} ago` : '—'}</td>
                <td className="row-actions">
                  <button
                    type="button"
                    className="btn btn-small btn-ghost"
                    disabled={busy}
                    onClick={async () => {
                      const r = await run(() => api(`/admin/users/${u.id}/link`, { method: 'POST' }), null);
                      if (r) setLink({ label: u.status === 'invited' ? `New invite for ${u.email}` : `Password reset for ${u.email}`, url: r.link });
                    }}
                  >
                    {u.status === 'invited' ? 'New invite link' : 'Reset password'}
                  </button>
                  {u.id !== meId && (u.status === 'disabled'
                    ? <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={() => run(() => api(`/admin/users/${u.id}`, { method: 'PATCH', body: { disabled: false } }), `${u.name} enabled`)}>Enable</button>
                    : <Confirm text={`Disable ${u.name}? They're signed out right away.`} onConfirm={() => run(() => api(`/admin/users/${u.id}`, { method: 'PATCH', body: { disabled: true } }), `${u.name} disabled`)} className="btn btn-small btn-ghost">Disable</Confirm>)}
                  {u.id !== meId && (
                    <Confirm text={`Remove ${u.name} and their settings? This can't be undone.`} onConfirm={() => run(() => api(`/admin/users/${u.id}`, { method: 'DELETE' }), `${u.name} removed`)} className="btn btn-small btn-ghost text-bad">Remove</Confirm>
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
