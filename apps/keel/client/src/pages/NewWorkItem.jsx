import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApi, useApp } from '../context.js';
import { t } from '../i18n.js';
import { useSticky } from '../sticky.js';
import { ErrorBox, Loading } from '../ui.jsx';

/**
 * New work item (drawer). preset: { projectId, teamId, type, parentId, parentTitle, types }
 * — e.g. from the Board (its project, team and backlog level) or "Add child" on a work item.
 * The item gets the team's default area, and the current sprint or the backlog.
 */
export default function NewWorkItem({ preset = {} }) {
  const { data: options, error } = useApi('/workitems/new/options');
  const { data: people } = useApi('/people');
  const { openDrawer, refresh, toast } = useApp();
  // The last project, team and type used here are the defaults next time.
  const [last, setLast] = useSticky('newWorkItem.last', {});
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);

  // Start once the options arrive: the preset first, then the last choices, then the first available.
  useEffect(() => {
    if (!options || form) return;
    const project = options.find((p) => p.id === preset.projectId || (p.name === preset.projectName && (!preset.org || !p.org || p.org === preset.org))) || options.find((p) => p.id === last.projectId) || options[0];
    if (!project) return;
    const team = project.teams.find((x) => x.id === preset.teamId) || project.teams.find((x) => x.id === last.teamId) || project.teams[0] || null;
    const allowed = preset.types?.length ? project.types.filter((x) => preset.types.includes(x)) : project.types;
    const type = [preset.type, last.type].find((x) => allowed.includes(x)) || allowed[0] || '';
    setForm({
      projectId: project.id, teamId: team?.id || '', type, title: '', description: '', assignedTo: '', priority: '2',
      iteration: preset.parentId || preset.iteration === 'sprint' || type === 'Task' ? 'sprint' : 'backlog', tags: '',
    });
  }, [options]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!options) return error ? <ErrorBox error={error} /> : <Loading />;
  if (!options.length) return <p className="muted">{t('Track a project in Settings first.')}</p>;
  if (!form) return <Loading />;

  const project = options.find((p) => p.id === form.projectId) || options[0];
  const team = project.teams.find((x) => x.id === form.teamId) || null;
  const types = preset.types?.length ? project.types.filter((x) => preset.types.includes(x)) : project.types;
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const changeProject = (id) => {
    const p = options.find((x) => x.id === id);
    set({ projectId: id, teamId: p.teams[0]?.id || '', type: p.types.includes(form.type) ? form.type : p.types[0] || '' });
  };

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const created = await api('/workitems', {
        method: 'POST',
        body: {
          ...form,
          parentId: preset.parentId || null,
          tags: form.tags.split(/[;,]/).map((x) => x.trim()).filter(Boolean),
        },
      });
      setLast({ projectId: form.projectId, teamId: form.teamId, type: form.type });
      toast(t('{type} {id} created', { type: form.type, id: created.id }));
      refresh();
      openDrawer({ type: 'workitem', id: created.id, org: created.org });
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="detail new-wi" onSubmit={submit}>
      <div className="detail-kicker">{preset.parentId ? t('Child of {id}', { id: preset.parentId }) : t('New work item')}</div>
      <h2 className="detail-title">{preset.parentTitle || t('New work item')}</h2>

      <div className="form-grid new-wi-grid">
        <label>{t('Project')}
          <select className="input" value={form.projectId} onChange={(e) => changeProject(e.target.value)} disabled={!!preset.parentId}>
            {options.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label>{t('Team')}
          <select className="input" value={form.teamId} onChange={(e) => set({ teamId: e.target.value })} disabled={!project.teams.length}>
            {!project.teams.length && <option value="">{t('No team selected in Settings')}</option>}
            {project.teams.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </label>
        <label>{t('Type')}
          <select className="input" value={form.type} onChange={(e) => set({ type: e.target.value })} required>
            {types.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </label>
        <label>{t('Priority')}
          <select className="input" value={form.priority} onChange={(e) => set({ priority: e.target.value })}>
            {['1', '2', '3', '4'].map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </label>
      </div>

      <label className="field-wide">{t('Title')}
        <input className="input" value={form.title} onChange={(e) => set({ title: e.target.value })} maxLength={255} required autoFocus placeholder={t('What needs to happen?')} />
      </label>
      <label className="field-wide"><span>{form.type === 'Bug' ? t('Repro steps') : t('Description')} <span className="muted small">{t('(optional)')}</span></span>
        <textarea className="input" rows={6} value={form.description} onChange={(e) => set({ description: e.target.value })} placeholder={form.type === 'Bug' ? t('Steps, what happened, what you expected') : ''} />
      </label>

      <div className="form-grid new-wi-grid">
        <label>{t('Assigned to')}
          <select className="input" value={form.assignedTo} onChange={(e) => set({ assignedTo: e.target.value })}>
            <option value="">{t('Unassigned')}</option>
            {(people || []).map((x) => <option key={x.id} value={x.uniqueName}>{x.displayName}</option>)}
          </select>
        </label>
        <label>{t('Plan it for')}
          <select className="input" value={form.iteration} onChange={(e) => set({ iteration: e.target.value })}>
            <option value="backlog">{t('The backlog')}</option>
            <option value="sprint" disabled={!team?.iteration}>{team?.iteration ? t('The current sprint ({name})', { name: team.iteration.name }) : t('The current sprint (none)')}</option>
          </select>
        </label>
        <label><span>{t('Tags')} <span className="muted small">{t('(optional)')}</span></span>
          <input className="input" value={form.tags} onChange={(e) => set({ tags: e.target.value })} placeholder={t('Separate with commas')} />
        </label>
      </div>
      {team?.areaPath && <p className="muted small">{t('Area: {path}', { path: team.areaPath })}</p>}

      <section className="detail-actions sticky-actions">
        <button type="submit" className="btn btn-primary btn-small" disabled={saving || !form.title.trim() || !form.type}>{saving ? t('Creating…') : t('Create {type}', { type: form.type || t('work item') })}</button>
      </section>
    </form>
  );
}
