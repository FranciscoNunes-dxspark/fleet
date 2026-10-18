import { useCallback, useEffect, useRef, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { initials, VOTES } from './format.js';
import { t } from './i18n.js';
import { useApp } from './context.js';
import { paletteVar, typeColorKey } from './typecolors.js';

/** Keel's mark: a sailboat with its keel and ballast bulb (same drawing as public/favicon.svg). */
export function Logo({ size = 28 }) {
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="7" fill="var(--accent)" />
      <path d="M16.6 3.8 23.8 11.4h-7.2z" fill="#ffffff" />
      <path d="M15.4 5.8 10.6 11.4h4.8z" fill="#ffffff" opacity=".75" />
      <path d="M4 12.6h24c-.7 2.7-2.6 4.6-5.6 4.9H10.2C7.3 17.2 5.2 15.4 4 12.6z" fill="#ffffff" />
      <path d="M14.2 17.4h4l-1 5.6h-2.2z" fill="var(--on-accent)" />
      <path d="M12.4 24.2c0-.9 1.8-1.6 4-1.6s4 .7 4 1.6-1.8 1.6-4 1.6-4-.7-4-1.6z" fill="var(--on-accent)" />
    </svg>
  );
}

export function Avatar({ person, size = 24, vote, title }) {
  if (!person) return <span className="avatar avatar-empty" style={{ width: size, height: size }} title={t('Unassigned')}>–</span>;
  const v = vote !== undefined && vote !== null ? VOTES[vote] : null;
  const label = title || `${person.displayName}${v ? ` — ${v.label}` : ''}`;
  return (
    <span className={`avatar ${person.isContainer ? 'avatar-group' : ''} ${v ? `vote-${v.tone}` : ''}`} style={{ width: size, height: size, fontSize: size * 0.4 }} title={label} aria-label={label}>
      {person.isContainer ? 'G' : initials(person.displayName)}
      {v?.glyph && <span className="vote-badge" aria-hidden="true">{v.glyph}</span>}
    </span>
  );
}

export function Person({ person, muted }) {
  return (
    <span className={`person ${muted ? 'muted' : ''}`}>
      <Avatar person={person} size={20} />
      <span className="truncate">{person?.displayName || t('Unassigned')}</span>
    </span>
  );
}

export const typeSlug = (type = '') => type.replace(/\s+/g, '-').toLowerCase();

/**
 * (type, Azure DevOps color) → inline style with the type's palette color, for
 * CSS that reads --type-color. Admins pick the colors in Settings.
 */
export function useTypeColor() {
  const { meta } = useApp();
  const chosen = meta?.typeColors;
  return useCallback((type, adoColor) => ({ '--type-color': paletteVar(typeColorKey(type, adoColor, chosen)) }), [chosen]);
}

/** "▌ Bug": the work item type with its color from the approved palette. */
export function TypeLabel({ type, color }) {
  const typeColor = useTypeColor();
  return <span className={`type type-${typeSlug(type)}`} style={typeColor(type, color)}>{type}</span>;
}

export const Chip = ({ tone = 'muted', children, title }) => <span className={`chip chip-${tone}`} title={title}>{children}</span>;

export function Loading({ label = t('Loading…') }) {
  return <div className="loading" role="status"><span className="spinner" aria-hidden="true" />{label}</div>;
}

export function ErrorBox({ error, onRetry }) {
  if (!error) return null;
  return (
    <div className="error-box" role="alert">
      <strong>{t("Couldn't load this view.")}</strong> {error.message}
      {onRetry && <button type="button" className="btn btn-small" onClick={onRetry}>{t('Try again')}</button>}
    </div>
  );
}

export function Empty({ title, children }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children && <div className="empty-body">{children}</div>}
    </div>
  );
}

export function PageHeader({ title, sub, children }) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {sub && <p className="page-sub">{sub}</p>}
      </div>
      {children && <div className="page-actions">{children}</div>}
    </header>
  );
}

/** Tabs that are pages of their own (each with its own address), shown under the page title. */
export function PageTabs({ label, tabs }) {
  return (
    <nav className="segmented page-tabs" aria-label={label}>
      {tabs.map((tab) => (
        <NavLink key={tab.to} to={tab.to} className={({ isActive }) => (isActive ? 'on' : '')}>{tab.label}</NavLink>
      ))}
    </nav>
  );
}

// Pages that share one menu entry (see App.jsx): Pull requests and Commits; Production, Waiting to ship and Platform totals.
export const CodeTabs = () => <PageTabs label={t('Code')} tabs={[{ to: '/prs', label: t('Pull requests') }, { to: '/commits', label: t('Commits') }]} />;
export const ProductionTabs = () => <PageTabs label={t('Production')} tabs={[{ to: '/production', label: t('Monitors') }, { to: '/ship', label: t('Waiting to ship') }, { to: '/totals', label: t('Platform totals') }]} />;

export function Drawer({ open, onClose, children, label }) {
  const ref = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // Focus the panel once when it opens. Re-running this on every parent render
  // used to pull focus (and scroll) away from the button you just clicked.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === 'Escape' && closeRef.current();
    window.addEventListener('keydown', onKey);
    ref.current?.focus({ preventScroll: true });
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  if (!open) return null;
  return (
    <div className="drawer-layer">
      <div className="drawer-scrim" onClick={onClose} aria-hidden="true" />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} ref={ref}>
        <button type="button" className="drawer-close" onClick={onClose} aria-label={t('Close panel')}>✕</button>
        {children}
      </aside>
    </div>
  );
}

export function ExternalLink({ href, children = t('Open in Azure DevOps'), className = 'btn btn-ghost btn-small' }) {
  if (!href) return null;
  return <a className={className} href={href} target="_blank" rel="noreferrer noopener">{children}<span className="ext" aria-hidden="true">↗</span></a>;
}

/** Sortable table header cell. */
export function Th({ id, sort, setSort, children, className }) {
  const active = sort.key === id;
  return (
    <th className={className} aria-sort={active ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="th-btn" onClick={() => setSort({ key: id, dir: active ? -sort.dir : 1 })}>
        {children}<span className="sort-ind" aria-hidden="true">{active ? (sort.dir === 1 ? '▲' : '▼') : ''}</span>
      </button>
    </th>
  );
}

export function useSort(initial, getters) {
  const [sort, setSort] = useState(initial);
  const apply = (rows) => {
    const get = getters[sort.key];
    if (!get) return rows;
    return [...rows].sort((a, b) => {
      const x = get(a);
      const y = get(b);
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return (typeof x === 'string' ? x.localeCompare(y) : x - y) * sort.dir;
    });
  };
  return { sort, setSort, apply };
}

export function Toggle({ checked, onChange, children, count }) {
  return (
    <button type="button" className={`toggle ${checked ? 'on' : ''}`} aria-pressed={checked} onClick={() => onChange(!checked)}>
      {children}{count !== undefined && <span className="toggle-count">{count}</span>}
    </button>
  );
}

/**
 * Keeps `el` at the same spot on screen for a few seconds while data refreshes
 * around it (rows inserted above, groups re-ordered). Stops as soon as you
 * scroll yourself. React reuses DOM nodes for stable keys, so the element
 * survives the re-render.
 */
let stopActivePin = null;

export function pinInView(el, ms = 6000) {
  if (!el) return;
  stopActivePin?.();
  const top = el.getBoundingClientRect().top;
  const offset = () => el.getBoundingClientRect().top - top;
  // Mutation callbacks run after React commits but before the browser paints,
  // so the correction is invisible (and works in background tabs too).
  const fix = () => {
    if (!el.isConnected) return stop();
    const diff = offset();
    if (Math.abs(diff) > 1) window.scrollBy(0, diff);
    return undefined;
  };
  // Content changes are corrected before any scroll event fires, so if the
  // element has drifted when one arrives, you scrolled (wheel, keys, scrollbar,
  // touch): stop pinning and let you go.
  const onScroll = () => Math.abs(offset()) > 2 && stop();
  const mo = new MutationObserver(fix);
  mo.observe(document.body, { childList: true, subtree: true, characterData: true });
  window.addEventListener('scroll', onScroll, { passive: true });
  const timer = setTimeout(() => stop(), ms);
  function stop() {
    mo.disconnect();
    clearTimeout(timer);
    window.removeEventListener('scroll', onScroll);
    if (stopActivePin === stop) stopActivePin = null;
  }
  stopActivePin = stop;
}

/**
 * A button that asks before acting. The question opens as a pop-over anchored
 * to the button, so the surrounding layout (often a table) never reflows.
 */
export function Confirm({ text, onConfirm, children, className = 'btn btn-small' }) {
  // Viewport position of the pop-over; fixed so table scroll containers can't clip it.
  const [pos, setPos] = useState(null);
  const wrap = useRef(null);
  const close = () => setPos(null);

  const open = (e) => {
    if (pos) return close();
    const r = e.currentTarget.getBoundingClientRect();
    const below = window.innerHeight - r.bottom > 110;
    setPos({
      right: Math.max(8, window.innerWidth - r.right),
      ...(below ? { top: r.bottom + 6 } : { bottom: window.innerHeight - r.top + 6 }),
    });
    return undefined;
  };

  useEffect(() => {
    if (!pos) return undefined;
    const away = (e) => !wrap.current?.contains(e.target) && close();
    const esc = (e) => e.key === 'Escape' && close();
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [pos]);

  return (
    <span className="confirm-wrap" ref={wrap}>
      <button type="button" className={className} aria-expanded={!!pos} onClick={open}>{children}</button>
      {pos && (
        <span className="confirm-pop" role="dialog" aria-label={text} style={pos}>
          <span className="confirm-text">{text}</span>
          <span className="confirm-actions">
            <button type="button" className="btn btn-small btn-ghost" onClick={close}>{t('Cancel')}</button>
            <button type="button" className="btn btn-small btn-danger" onClick={() => { close(); onConfirm(); }}>{t('Yes')}</button>
          </span>
        </span>
      )}
    </span>
  );
}
