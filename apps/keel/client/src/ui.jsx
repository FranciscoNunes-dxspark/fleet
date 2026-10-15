import { useEffect, useRef, useState } from 'react';
import { initials, VOTES } from './format.js';

/** Shipdeck's rocket mark (same drawing as public/favicon.svg). */
export function Logo({ size = 28 }) {
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="7" fill="var(--accent)" />
      <g transform="rotate(45 16 16)">
        <path d="M14 22.5h4l-.6 3.2L16 28l-1.4-2.3z" fill="#ffd166" />
        <path d="M12.2 17.5 9 21v2.5l3.2-1.4z" fill="var(--on-accent)" />
        <path d="M19.8 17.5 23 21v2.5l-3.2-1.4z" fill="var(--on-accent)" />
        <path d="M16 4c2.9 2.3 4.4 5.8 4.4 9.8v8.7h-8.8v-8.7C11.6 9.8 13.1 6.3 16 4z" fill="#ffffff" />
        <circle cx="16" cy="12.6" r="2" fill="var(--accent)" stroke="var(--on-accent)" strokeWidth="1" />
      </g>
    </svg>
  );
}

export function Avatar({ person, size = 24, vote, title }) {
  if (!person) return <span className="avatar avatar-empty" style={{ width: size, height: size }} title="Unassigned">–</span>;
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
      <span className="truncate">{person?.displayName || 'Unassigned'}</span>
    </span>
  );
}

export const Chip = ({ tone = 'muted', children, title }) => <span className={`chip chip-${tone}`} title={title}>{children}</span>;

export function Loading({ label = 'Loading…' }) {
  return <div className="loading" role="status"><span className="spinner" aria-hidden="true" />{label}</div>;
}

export function ErrorBox({ error, onRetry }) {
  if (!error) return null;
  return (
    <div className="error-box" role="alert">
      <strong>Couldn't load this view.</strong> {error.message}
      {onRetry && <button type="button" className="btn btn-small" onClick={onRetry}>Try again</button>}
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
        <button type="button" className="drawer-close" onClick={onClose} aria-label="Close panel">✕</button>
        {children}
      </aside>
    </div>
  );
}

export function ExternalLink({ href, children = 'Open in Azure DevOps', className = 'btn btn-ghost btn-small' }) {
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
            <button type="button" className="btn btn-small btn-ghost" onClick={close}>Cancel</button>
            <button type="button" className="btn btn-small btn-danger" onClick={() => { close(); onConfirm(); }}>Yes</button>
          </span>
        </span>
      )}
    </span>
  );
}
