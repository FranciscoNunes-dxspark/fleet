// Saved views: a page's filters under a name ("My team's stale PRs"), kept on
// your account like the theme, and links that open a page with given filters
// (?f=…), to send to someone. Pages describe their filters as a plain object
// and say how to apply one (see PullRequests.jsx, WorkItems.jsx, Commits.jsx).
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PREF_KEYS, pushPref } from './prefs.js';
import { useApp } from './context.js';
import { t } from './i18n.js';

const KEY = PREF_KEYS.views;
const MAX = 12; // per page

/** Filters without their empty values, so "no filter" compares equal however it's written. */
export function clean(filters) {
  const out = {};
  for (const [k, v] of Object.entries(filters || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const inner = clean(v);
      if (Object.keys(inner).length) out[k] = inner;
    } else if (v !== '' && v !== null && v !== undefined && v !== false) {
      out[k] = v;
    }
  }
  return out;
}
const same = (a, b) => JSON.stringify(clean(a)) === JSON.stringify(clean(b));

// base64url of the JSON, so a link survives chat apps and email.
export const encodeFilters = (f) => btoa(unescape(encodeURIComponent(JSON.stringify(clean(f))))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export function decodeFilters(s) {
  try {
    const v = JSON.parse(decodeURIComponent(escape(atob(String(s).replace(/-/g, '+').replace(/_/g, '/')))));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

const readAll = () => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
};
const writeAll = (all) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // Storage blocked: the account copy below still keeps it.
  }
  pushPref('views', all);
};

/**
 * The saved views bar for one page. `filters`: what the page shows now;
 * `apply(filters)`: show those instead (missing keys mean "no filter").
 * A link with ?f= applies its filters once, then leaves the address clean.
 */
export function SavedViews({ page, filters, apply }) {
  const { toast } = useApp();
  const [all, setAll] = useState(readAll);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [params, setParams] = useSearchParams();
  const applyRef = useRef(apply);
  applyRef.current = apply;
  const views = all[page] || [];

  useEffect(() => {
    const f = params.get('f');
    if (!f) return;
    const decoded = decodeFilters(f);
    const next = new URLSearchParams(params);
    next.delete('f');
    setParams(next, { replace: true });
    if (decoded) applyRef.current(decoded);
  }, [params]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = (list) => {
    const next = { ...readAll(), [page]: list };
    if (!list.length) delete next[page];
    setAll(next);
    writeAll(next);
  };
  const add = (e) => {
    e.preventDefault();
    const n = name.trim().slice(0, 60);
    if (!n) return;
    save([...views.filter((v) => v.name !== n), { id: Math.random().toString(36).slice(2, 10), name: n, filters: clean(filters) }].slice(-MAX));
    setNaming(false);
    setName('');
    toast(t('View "{name}" saved', { name: n }));
  };
  const copyLink = async () => {
    const url = new URL(window.location.href);
    url.searchParams.set('f', encodeFilters(filters));
    try {
      await navigator.clipboard.writeText(url.href);
      toast(t('Link copied: it opens this page with these filters'));
    } catch {
      toast(t('Copy failed. Select the text and copy it yourself.'), 'bad');
    }
  };
  const empty = !Object.keys(clean(filters)).length;

  return (
    <div className="saved-views" role="group" aria-label={t('Saved views')}>
      {views.map((v) => (
        <span key={v.id} className={`saved-view${same(v.filters, filters) ? ' on' : ''}`}>
          <button type="button" className="saved-view-name" onClick={() => apply(v.filters)} aria-pressed={same(v.filters, filters)}>{v.name}</button>
          <button type="button" className="saved-view-x" onClick={() => save(views.filter((x) => x.id !== v.id))} aria-label={t('Remove the view {name}', { name: v.name })} title={t('Remove')}>✕</button>
        </span>
      ))}
      {naming ? (
        <form className="inline-form saved-view-form" onSubmit={add}>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('Name this view')} aria-label={t('Name this view')} autoFocus maxLength={60} onKeyDown={(e) => e.key === 'Escape' && setNaming(false)} />
          <button type="submit" className="btn btn-small btn-primary" disabled={!name.trim()}>{t('Save')}</button>
          <button type="button" className="btn btn-small btn-ghost" onClick={() => setNaming(false)}>{t('Cancel')}</button>
        </form>
      ) : (
        <>
          <button type="button" className="btn btn-small btn-ghost" onClick={() => setNaming(true)} disabled={empty} title={empty ? t('Pick some filters first') : undefined}>{t('Save view')}</button>
          <button type="button" className="btn btn-small btn-ghost" onClick={copyLink} disabled={empty}>{t('Copy link')}</button>
        </>
      )}
    </div>
  );
}
