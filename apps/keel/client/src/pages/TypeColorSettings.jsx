import { useState } from 'react';
import { api } from '../api.js';
import { useApi, useApp } from '../context.js';
import { t } from '../i18n.js';
import { PALETTE, autoTypeColor, paletteVar, typeColorKey } from '../typecolors.js';
import { ErrorBox, Loading, Section, TypeLabel } from '../ui.jsx';

/**
 * Work item type colors, the same for everyone: Admins pick each type's color
 * from the approved palette; "Automatic" uses the palette color closest to the
 * type's color in Azure DevOps. Saved as soon as you pick.
 */
export default function TypeColorSettings() {
  const { can, toast, refresh } = useApp();
  const { data, error, reload } = useApi('/workitem-types');
  const [saving, setSaving] = useState(null);
  const admin = can('typecolors.manage');

  if (error) return <section className="panel"><ErrorBox error={error} onRetry={reload} /></section>;
  if (!data) return <section className="panel"><Loading /></section>;
  if (!data.types.length) return null;

  const pick = async (type, key) => {
    const colors = { ...data.colors };
    if (key) colors[type] = key;
    else delete colors[type];
    setSaving(type);
    try {
      await api('/workitem-types/colors', { method: 'PUT', body: { colors } });
      toast(key ? t('{type} is now {color}', { type, color: t(PALETTE.find((p) => p.key === key).label) }) : t('{type} uses its automatic color', { type }));
      reload();
      refresh(); // everyone's lists pick it up with the next /meta
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      setSaving(null);
    }
  };

  return (
    <Section id="type-colors" title={t('Work item type colors')} note={admin && <span className="saved-note">{t('Saved automatically')}</span>}>
      <p className="muted small">
        {admin
          ? t('Colors come from an approved palette that stays readable in light and dark mode. Automatic uses the palette color closest to the type\'s color in Azure DevOps. The same for everyone.')
          : t('Set by Admins from an approved palette, the same for everyone.')}
      </p>
      <ul className="type-color-list">
        {data.types.map((ty) => {
          const chosen = data.colors[ty.name] || '';
          const auto = autoTypeColor(ty.name, ty.color);
          return (
            <li key={ty.name} className="type-color-row">
              <div className="type-color-name">
                <TypeLabel type={ty.name} color={ty.color} />
                <span className="small muted truncate" title={ty.projects.join(', ')}>{ty.projects.join(', ')}</span>
              </div>
              {admin ? (
                <div className="tc-swatches" role="radiogroup" aria-label={t('Color for {type}', { type: ty.name })} aria-busy={saving === ty.name}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={!chosen}
                    className={`tc-auto${!chosen ? ' on' : ''}`}
                    disabled={saving === ty.name}
                    onClick={() => chosen && pick(ty.name, '')}
                    title={t('Automatic: {color}', { color: t(PALETTE.find((p) => p.key === auto).label) })}
                  >
                    <span className="tc-dot" style={{ background: paletteVar(auto) }} aria-hidden="true" />{t('Automatic')}
                  </button>
                  {PALETTE.map((p) => (
                    <button
                      key={p.key}
                      type="button"
                      role="radio"
                      aria-checked={chosen === p.key}
                      aria-label={t(p.label)}
                      title={t(p.label)}
                      className={`tc-swatch${chosen === p.key ? ' on' : ''}`}
                      style={{ background: paletteVar(p.key) }}
                      disabled={saving === ty.name}
                      onClick={() => chosen !== p.key && pick(ty.name, p.key)}
                    />
                  ))}
                </div>
              ) : (
                <span className="small muted">{chosen ? t(PALETTE.find((p) => p.key === typeColorKey(ty.name, ty.color, data.colors)).label) : t('Automatic')}</span>
              )}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
