import { useCallback, useEffect, useRef, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { initials, VOTES } from './format.js';
import { t, tx } from './i18n.js';
import { useApp } from './context.js';
import { useSourceName } from './orgs.js';
import { paletteVar, typeColorKey } from './typecolors.js';
import { useSticky } from './sticky.js';
import { Icon } from './icons.jsx';
import { stageName, stageOfPath } from './line/names.js';
import { BG, PALETTE, pinchPixels } from './pinch.js';

// One rect per run of same-coloured pixels, for each mood. Built once each: the drawing never changes.
const RUNS = {};
const pinchRuns = (mood) => (RUNS[mood] ??= pinchPixels(mood).flatMap((row, y) =>
  [...row.matchAll(/([^.])\1*/g)].map((m) => ({ x: m.index, y, w: m[0].length, fill: PALETTE[m[1]] }))));

/** Pinch's pixels at (dx, dy). "look" glances from side to side: two frames swapped by CSS, a still one with reduced motion. */
function PinchPixels({ mood, dx = 0, dy = 0 }) {
  const rects = (m) => pinchRuns(m).map((r) => <rect key={`${r.x},${r.y}`} x={r.x + dx} y={r.y + dy} width={r.w} height="1.02" fill={r.fill} />);
  if (mood !== 'look') return rects(mood);
  return (
    <>
      <g className="pinch-frame-a">{rects('look')}</g>
      <g className="pinch-frame-b">{rects('idle')}</g>
    </>
  );
}

/** Keel's mark: Pinch the crab on its dark square, without the Azure DevOps badge the app icons carry (same pixels as public/favicon.svg). */
export function Logo({ size = 28, mood = 'idle', title }) {
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 20 20" focusable="false" {...(title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true })}>
      {title && <title>{title}</title>}
      <rect width="20" height="20" rx="3.6" fill={BG} />
      <PinchPixels mood={mood} dx={2} dy={5} />
    </svg>
  );
}

/** Pinch on its own, `width` pixels wide, for empty states, loading and errors. */
export function Pinch({ mood = 'idle', width = 64, title }) {
  return (
    <svg className={`pinch pinch-${mood}`} width={width} height={(width * 10) / 16} viewBox="0 0 16 10" focusable="false" {...(title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true })}>
      {title && <title>{title}</title>}
      <PinchPixels mood={mood} />
    </svg>
  );
}

/** What Pinch has to say about its mood (see pinchMood), for the logo's tooltip. */
export function pinchLine(mood, { attention, live } = {}) {
  if (mood === 'worried') return t("Pinch can't reach Azure DevOps: {error}", { error: tx(live?.error || '') });
  if (mood === 'look') return t('Pinch is checking Azure DevOps…');
  if (mood === 'sleep') return t('Nothing needs you, so Pinch is having a nap.');
  if (!attention) return t('Pinch is keeping an eye on Azure DevOps.');
  const n = attention.summary?.high || 0;
  if (n === 1) return t('One thing needs you now.');
  if (n) return t('{n} things need you now.', { n });
  return t('Nothing urgent right now.');
}

/** A steady hue (0–359) for a person, from their email or name, so they look the same everywhere. */
export function hueOf(person) {
  const key = String(person?.uniqueName || person?.displayName || person?.id || '').toLowerCase();
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

export function Avatar({ person, size = 24, vote, title }) {
  if (!person) return <span className="avatar avatar-empty" style={{ width: size, height: size }} title={t('Unassigned')}>–</span>;
  const v = vote !== undefined && vote !== null ? VOTES[vote] : null;
  const label = title || `${person.displayName}${v ? ` — ${v.label}` : ''}`;
  const hued = !person.isContainer;
  return (
    <span
      className={`avatar ${person.isContainer ? 'avatar-group' : 'avatar-hued'} ${v ? `vote-${v.tone}` : ''}`}
      style={{ width: size, height: size, fontSize: size * 0.4, ...(hued ? { '--av-h': hueOf(person) } : {}) }}
      title={label}
      aria-label={label}
    >
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

/** A spinner, or a glancing Pinch when it holds a whole page (the CSS picks which). */
export function Loading({ label = t('Loading…') }) {
  return <div className="loading" role="status"><Pinch mood="look" width={48} /><span className="spinner" aria-hidden="true" />{label}</div>;
}

export function ErrorBox({ error, onRetry }) {
  if (!error) return null;
  return (
    <div className="error-box" role="alert">
      <Pinch mood="worried" width={32} />
      <strong>{t("Couldn't load this view.")}</strong> {error.message}
      {onRetry && <button type="button" className="btn btn-small" onClick={onRetry}>{t('Try again')}</button>}
    </div>
  );
}

/** An empty list's message; `mood` adds Pinch above it (asleep on Inbox zero). */
export function Empty({ title, mood, children }) {
  return (
    <div className="empty">
      {mood && <Pinch mood={mood} width={64} />}
      <p className="empty-title">{title}</p>
      {children && <div className="empty-body">{children}</div>}
    </div>
  );
}

/**
 * The page title and its actions. It stays pinned at the top as you scroll,
 * on a frosted backdrop; once it's pinned (the marker before it has scrolled
 * away) it gets a hairline and a shadow.
 */
// Each page's icon, and the line above its title: the stage of the Line it belongs to
// (line/names.js), or nothing for a page beside the line.
const ICONS = [
  ['/inbox', 'inbox'], ['/summary', 'summary'], ['/work', 'workItems'], ['/epics', 'workItems'], ['/board', 'board'],
  ['/prs', 'pullRequests'], ['/commits', 'pullRequests'], ['/release-notes', 'pullRequests'],
  ['/pipelines', 'pipelines'], ['/production', 'production'], ['/ship', 'production'], ['/totals', 'production'],
  ['/team', 'team'], ['/users', 'team'], ['/people', 'team'], ['/insights', 'insights'], ['/settings', 'settings'],
];

// How far back into view the spot above a pinned page header must come before it unpins (PageHeader).
const UNPIN_SLACK = 96;

export function PageHeader({ title, sub, children }) {
  const { pathname } = useLocation();
  const icon = ICONS.find(([prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`))?.[1];
  const stage = stageOfPath(pathname);
  const marker = useRef(null);
  const header = useRef(null);
  const [stuck, setStuck] = useState(false);
  // Pinned when the spot above it scrolls under the top bar. Pinned, the header shrinks, so the page
  // gets shorter, and a page a little taller than the window scrolls back by that much; unpinning
  // as soon as the spot shows again would make the page taller, pin it again, and flicker. So it
  // unpins only once the spot is well back in view (more than any header shrinks), or at the top.
  useEffect(() => {
    const check = () => {
      const m = marker.current;
      const el = header.current;
      if (!m || !el) return;
      const pin = parseFloat(getComputedStyle(el).top) || 0;
      const top = m.getBoundingClientRect().top;
      setStuck((was) => (window.scrollY <= 0 ? false : was ? top < pin + UNPIN_SLACK : top < pin));
    };
    check();
    window.addEventListener('scroll', check, { passive: true });
    window.addEventListener('resize', check);
    return () => { window.removeEventListener('scroll', check); window.removeEventListener('resize', check); };
  }, []);
  return (
    <>
      <div ref={marker} className="page-header-marker" aria-hidden="true" />
      <header ref={header} className={`page-header${stuck ? ' page-header-stuck' : ''}`}>
        <div className="page-title">
          {icon && <span className="page-icon" aria-hidden="true"><Icon name={icon} size={20} /></span>}
          <div className="page-title-text">
            {stage && <div className="page-eyebrow">{stageName(stage)}</div>}
            <h1>{title}</h1>
            {sub && <p className="page-sub">{sub}</p>}
          </div>
        </div>
        {children && <div className="page-actions">{children}</div>}
      </header>
    </>
  );
}

/** Tabs that are pages of their own (each with its own address), shown under the page title. */
/**
 * A Settings section that folds away: its title opens and closes it, remembered
 * per browser. A link to it (#id, say from Waiting to ship) always opens it.
 * Folded content stays mounted, so unsaved edits in it aren't lost.
 */
export function Section({ id, title, note, children }) {
  const [folded, setFolded] = useSticky(`settings.folded.${id}`, false);
  const { hash } = useLocation();
  useEffect(() => {
    if (hash === `#${id}`) setFolded(false);
  }, [hash, id, setFolded]);
  const open = !folded;
  return (
    <section className={`panel fold${open ? '' : ' folded'}`} id={id}>
      <h2 className="section-title">
        <button type="button" className="fold-toggle" aria-expanded={open} aria-controls={`${id}-body`} onClick={() => setFolded(open)}>
          <svg className="fold-chevron" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
          {title}
        </button>
        {note}
      </h2>
      <div id={`${id}-body`} hidden={!open}>{children}</div>
    </section>
  );
}

export function PageTabs({ label, tabs }) {
  return (
    <nav className="segmented page-tabs" aria-label={label}>
      {tabs.map((tab) => (
        <NavLink key={tab.to} to={tab.to} className={({ isActive }) => (isActive ? 'on' : '')}>{tab.label}</NavLink>
      ))}
    </nav>
  );
}

// Pages that share a stage of the Line (Pull requests, Commits and Release notes; Monitors, Waiting to ship and
// Platform totals; Work items and Epics) are its tabs now, in the frame (line/LineShell.jsx), so the pages
// draw none of their own. Kept as names so the pages need no change.
export const CodeTabs = () => null;
export const ProductionTabs = () => null;
export const WorkTabs = () => null;
/** Team: the Line person by person, each person's workload, and Users for Admins of a Keel with accounts. */
export function TeamTabs() {
  const { authMode, can } = useApp();
  const tabs = [{ to: '/people', label: t('On the line') }, { to: '/team', label: t('Workload') }];
  if (authMode === 'login' && can('users.manage')) tabs.push({ to: '/users', label: t('Users') });
  return <PageTabs label={t('Team')} tabs={tabs} />;
}

/**
 * The details panel. Modal by default: it slides over the page behind a scrim and takes the focus.
 * Docked (wide screens, see useDocked), it is an inspector beside the page instead: no scrim, the
 * page keeps scrolling and stays clickable, and the focus stays where it was, so a list can be
 * walked with the keyboard while the panel follows.
 */
export function Drawer({ open, onClose, children, label, docked = false }) {
  const ref = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // Focus the panel once when it opens. Re-running this on every parent render
  // used to pull focus (and scroll) away from the button you just clicked.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === 'Escape' && closeRef.current();
    window.addEventListener('keydown', onKey);
    // The page behind stays put while the panel is open: one scrollbar, the panel's.
    // Docked, the page makes room for the panel instead.
    const cls = docked ? 'inspector-open' : 'drawer-open';
    if (!docked) ref.current?.focus({ preventScroll: true });
    document.documentElement.classList.add(cls);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.documentElement.classList.remove(cls);
    };
  }, [open, docked]);
  if (!open) return null;
  const close = <button type="button" className="drawer-close" onClick={onClose} aria-label={t('Close panel')}>✕</button>;
  if (docked) {
    return (
      <aside className="drawer drawer-docked" aria-label={label} tabIndex={-1} ref={ref}>
        {close}
        {children}
      </aside>
    );
  }
  return (
    <div className="drawer-layer">
      <div className="drawer-scrim" onClick={onClose} aria-hidden="true" />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} ref={ref}>
        {close}
        {children}
      </aside>
    </div>
  );
}

/** Whether a media query matches, following it as the window changes. */
export function useMedia(query) {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(query).matches);
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return undefined;
    const on = () => setMatches(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return matches;
}

/**
 * Whether the details panel docks beside the page: only where the page keeps enough room beside it
 * (1500px with the menu; the Line, which has no menu down the side, asks from 1200px).
 */
export const useDocked = (minWidth = 1500) => useMedia(`(min-width: ${minWidth}px)`);

/** Whether two drawer targets name the same thing (the row a list marks as open). */
export function sameTarget(a, b) {
  if (!a || !b || a.type !== b.type) return false;
  return String(a.id ?? '') === String(b.id ?? '') && String(a.key ?? '') === String(b.key ?? '')
    && String(a.repoId ?? '') === String(b.repoId ?? '') && (a.org || '') === (b.org || '');
}

export function ExternalLink({ href, children, className = 'btn btn-ghost btn-small' }) {
  const sourceName = useSourceName();
  if (!href) return null;
  children ??= sourceName(href) === 'GitHub' ? t('Open in GitHub') : t('Open in Azure DevOps');
  return <a className={className} href={href} target="_blank" rel="noreferrer noopener">{children}<span className="ext" aria-hidden="true">↗</span></a>;
}

/**
 * Phones: a page's filters fold behind one button that says how many are on; `lead` (the page's
 * own view switch, say Active | Closed) stays beside it. Wider screens show the filters as they are.
 */
export function FilterFold({ active = 0, lead = null, children }) {
  const phone = useMedia('(max-width: 900px)');
  const [open, setOpen] = useState(false);
  if (!phone) return children;
  return (
    <>
      <div className="filter-fold-bar">
        {lead}
        <button type="button" className={`btn btn-small filter-fold-btn${active ? ' on' : ''}`} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <Icon name="search" size={14} /> {t('Filters')}{active > 0 && <span className="filter-fold-n">{active}</span>}
        </button>
      </div>
      {open && <div className="filter-fold">{children}</div>}
    </>
  );
}

/** A list's sort as a menu, where there are no column headings to tap (phones). `options`: [[key, label]]. */
export function SortPick({ sort, setSort, options }) {
  return (
    <span className="sort-pick">
      <select className="input" value={sort.key} onChange={(e) => setSort({ key: e.target.value, dir: sort.dir })} aria-label={t('Sort by')}>
        {options.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select>
      <button type="button" className="btn btn-small" onClick={() => setSort({ key: sort.key, dir: -sort.dir })} aria-label={sort.dir === 1 ? t('Ascending') : t('Descending')} title={sort.dir === 1 ? t('Ascending') : t('Descending')}>
        {sort.dir === 1 ? '↑' : '↓'}
      </button>
    </span>
  );
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
