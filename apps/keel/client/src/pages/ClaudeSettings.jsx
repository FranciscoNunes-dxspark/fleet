import { useState } from 'react';
import { api } from '../api.js';
import { useApi, useApp } from '../context.js';
import { dateTime } from '../format.js';
import { Confirm, ErrorBox, Loading } from '../ui.jsx';
import { t } from '../i18n.js';

const PLACEHOLDER = '<your token>';

/** What to paste where, for each Claude app. */
function setupFor(app, url, token) {
  if (app === 'code') return `claude mcp add --transport http keel ${url} --header "Authorization: Bearer ${token}"`;
  return JSON.stringify({
    mcpServers: {
      keel: {
        command: 'npx',
        args: ['-y', 'mcp-remote', url, '--header', 'Authorization:${KEEL_AUTH}'],
        env: { KEEL_AUTH: `Bearer ${token}` },
      },
    },
  }, null, 2);
}

/**
 * Settings → Claude: connection tokens for the Claude connector (server/mcp.js),
 * so you can ask Claude to file and look up work items and read recent commits.
 * Each person manages their own; a token is shown once, right after it's made.
 */
export default function ClaudeSettings() {
  const { toast } = useApp();
  const { data, error, reload } = useApi('/mcp/tokens');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState(null); // { token, entry }, until you leave the page
  const [app, setApp] = useState('desktop');
  const url = `${window.location.origin}/mcp`;

  const create = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      setCreated(await api('/mcp/tokens', { method: 'POST', body: { name: name.trim() || (app === 'code' ? 'Claude Code' : 'Claude Desktop') } }));
      setName('');
      reload();
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id) => {
    try {
      await api(`/mcp/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (created?.entry.id === id) setCreated(null);
      toast(t('Connection removed. Claude can no longer use it.'));
      reload();
    } catch (err) {
      toast(err.message, 'bad');
    }
  };

  const copy = async (text, done) => {
    try {
      await navigator.clipboard.writeText(text);
      toast(done);
    } catch {
      toast(t('Couldn’t copy. Your browser blocked the clipboard.'), 'bad');
    }
  };

  const snippet = setupFor(app, url, created?.token || PLACEHOLDER);

  return (
    <section className="panel claude-settings">
      <h2 className="section-title">{t('Claude')}</h2>
      <p className="muted small">{t('Connect Claude to Keel to file work items, look them up, comment on them and ask about recent commits, just by asking. Claude acts as you: your role, your Azure DevOps account and the projects you track here. It asks before filing anything.')}</p>

      <div className="segmented segmented-compact" role="radiogroup" aria-label={t('Claude app')}>
        <button type="button" role="radio" aria-checked={app === 'desktop'} className={app === 'desktop' ? 'on' : ''} onClick={() => setApp('desktop')}>Claude Desktop</button>
        <button type="button" role="radio" aria-checked={app === 'code'} className={app === 'code' ? 'on' : ''} onClick={() => setApp('code')}>Claude Code</button>
      </div>

      <ol className="claude-steps small">
        <li>{t('Create a connection below. Copy the token right away: it is shown only once.')}</li>
        <li>
          {app === 'desktop'
            ? t('In Claude Desktop, open Settings → Developer → Edit Config, and add this to claude_desktop_config.json (it needs Node.js installed):')
            : t('Run this in a terminal:')}
          <div className="claude-snippet">
            <pre className="mono small">{snippet}</pre>
            <button type="button" className="btn btn-small" onClick={() => copy(snippet, t('Copied'))}>{t('Copy')}</button>
          </div>
        </li>
        <li>
          {app === 'desktop'
            ? t('Restart Claude Desktop. Keel shows up in the tools menu; then ask, for example: "File a bug in Commerce: the checkout button does nothing on Safari".')
            : t('Start Claude Code and type /mcp to check Keel is connected.')}
        </li>
      </ol>
      {!created && <p className="muted small">{t('{token} is replaced with your token once you create a connection.', { token: PLACEHOLDER })}</p>}

      {created && (
        <div className="claude-token" role="status">
          <strong>{t('Your new token for "{name}"', { name: created.entry.name })}</strong>
          <p className="small">{t("Copy it now. Keel keeps only a fingerprint, so you can't see it again. Treat it like a password: anyone with it can act in Azure DevOps as you.")}</p>
          <div className="claude-snippet">
            <code className="mono small">{created.token}</code>
            <button type="button" className="btn btn-small btn-primary" onClick={() => copy(created.token, t('Token copied'))}>{t('Copy token')}</button>
          </div>
        </div>
      )}

      <form className="claude-create" onSubmit={create}>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder={t('Name, e.g. "Laptop" or "Claude Desktop"')} aria-label={t('Connection name')} />
        <button type="submit" className="btn btn-small btn-primary" disabled={busy}>{busy ? t('Creating…') : t('Create connection')}</button>
      </form>

      <h3 className="small">{t('Your connections')}</h3>
      {!data ? (error ? <ErrorBox error={error} onRetry={reload} /> : <Loading />) : !data.length ? (
        <p className="muted small">{t('None yet.')}</p>
      ) : (
        <ul className="claude-tokens">
          {data.map((tok) => (
            <li key={tok.id}>
              <span className="strong">{tok.name}</span>
              <span className="muted small">{t('Created {date}', { date: dateTime(tok.createdAt) })} · {tok.lastUsedAt ? t('last used {date}', { date: dateTime(tok.lastUsedAt) }) : t('not used yet')}</span>
              <Confirm text={t('Remove this connection? Claude stops working with it at once.')} onConfirm={() => remove(tok.id)} className="btn btn-small btn-ghost text-bad">{t('Remove')}</Confirm>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
