import { Children, Fragment, isValidElement, useCallback, useEffect, useId, useRef, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { Collapsible, Dialog, Toggle as RxToggle, VisuallyHidden } from 'radix-ui';
import { AlertDialog, Button, Checkbox as RtCheckbox, Select as RtSelect, Theme, Tooltip as RtTooltip } from '@radix-ui/themes';
import { initials, VOTES } from './format.js';
import { t, tx } from './i18n.js';
import { useApp } from './context.js';
import { useSourceName } from './orgs.js';
import { paletteVar, typeColorKey } from './typecolors.js';
import { useSticky } from './sticky.js';
import { Icon } from './icons.jsx';
import { stageName, stageOfPath } from './line/names.js';
import { PALETTE, pinchPixels } from './pinch.js';
import { MARK } from './mark.js';

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

const CHEVRON = `M${MARK.chevron.map(([x, y]) => `${x} ${y}`).join(' L')} Z`;

/**
 * Keel's mark (mark.js, the same drawing as public/favicon.svg): the prompt and its cursor, cut at the
 * waterline. `mood` (pinchMood) shows on it: the cursor blinks while Keel checks Azure DevOps, and a red
 * dot shows when it can't reach it.
 */
export function Logo({ size = 28, mood = 'idle', title }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const { tile, waterline, gap, bar, colours } = MARK;
  const k = (side) => (
    <>
      <rect className="mark-cursor" x={bar.x} y={bar.y} width={bar.w} height={bar.h} rx={bar.r} fill={colours.bar[side]} />
      <path d={CHEVRON} fill={colours.chevron[side]} />
    </>
  );
  return (
    <svg className={`brand-mark brand-mark-${mood}`} width={size} height={size} viewBox={`0 0 ${MARK.size} ${MARK.size}`} focusable="false" {...(title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true })}>
      {title && <title>{title}</title>}
      <defs>
        <clipPath id={`${id}a`}><rect width={MARK.size} height={waterline} /></clipPath>
        <clipPath id={`${id}b`}><rect y={waterline + gap} width={MARK.size} height={MARK.size - waterline - gap} /></clipPath>
      </defs>
      <rect width={MARK.size} height={MARK.size} rx={tile.radius} fill={tile.fill} />
      <g clipPath={`url(#${id}a)`}>{k('above')}</g>
      <g clipPath={`url(#${id}b)`}>{k('below')}</g>
      {mood === 'worried' && <circle className="mark-alert" cx="54" cy="10" r="8" stroke={tile.fill} strokeWidth="3" />}
    </svg>
  );
}

/** Pinch on its own, `width` pixels wide, for empty states and errors. */
export function Pinch({ mood = 'idle', width = 64, title }) {
  return (
    <svg className={`pinch pinch-${mood}`} width={width} height={(width * 10) / 16} viewBox="0 0 16 10" focusable="false" {...(title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true })}>
      {title && <title>{title}</title>}
      <PinchPixels mood={mood} />
    </svg>
  );
}

/** What the logo's mood (see pinchMood) means, for its tooltip. */
export function statusLine(mood, { attention, live } = {}) {
  if (mood === 'worried') return t("Can't reach Azure DevOps: {error}", { error: tx(live?.error || '') });
  if (mood === 'look') return t('Checking Azure DevOps…');
  if (mood === 'sleep') return t('Nothing needs you right now.');
  if (!attention) return t('Keeping an eye on Azure DevOps.');
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

/** A spinner, or Keel's mark with its cursor blinking when it holds a whole page (the CSS picks which). */
export function Loading({ label = t('Loading…') }) {
  return <div className="loading" role="status"><Logo mood="look" size={48} /><span className="spinner" aria-hidden="true" />{label}</div>;
}

export function ErrorBox({ error, onRetry }) {
  if (!error) return null;
  return (
    <div className="error-box" role="alert">
      <Pinch mood="worried" width={32} />
      <strong>{t("Couldn't load this view.")}</strong> {error.message}
      {onRetry && <Button size="1" variant="outline" color="gray" type="button" onClick={onRetry}>{t('Try again')}</Button>}
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
// Whether the modal panel is opened wide; each viewer's own choice, kept in this browser.
const WIDE_KEY = 'keel.drawer.wide';
const readWide = () => { try { return localStorage.getItem(WIDE_KEY) === '1'; } catch { return false; } };

export function Drawer({ open, onClose, children, label, docked = false }) {
  const ref = useRef(null);
  const [wide, setWide] = useState(readWide);
  const toggleWide = () => setWide((w) => {
    try { localStorage.setItem(WIDE_KEY, w ? '0' : '1'); } catch { /* private window: this visit only */ }
    return !w;
  });
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // The page behind stays put while the panel is open: one scrollbar, the panel's. Docked, the
  // page makes room for the panel instead, and Escape is ours (a modal panel's is Radix's).
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === 'Escape' && docked && closeRef.current();
    window.addEventListener('keydown', onKey);
    const cls = docked ? 'inspector-open' : 'drawer-open';
    const root = document.documentElement;
    root.classList.add(cls);
    // Wide sets the panel's width on the page, where the toasts beside it read it too.
    root.classList.toggle('drawer-wide-open', wide && !docked);
    return () => {
      window.removeEventListener('keydown', onKey);
      root.classList.remove(cls, 'drawer-wide-open');
    };
  }, [open, docked, wide]);
  if (!open) return null;
  // The panel's own buttons, pinned to its top corner while its contents scroll under them.
  const tools = (
    <div className="drawer-tools">
      {!docked && (
        <button type="button" className="drawer-tool drawer-widen" onClick={toggleWide} aria-pressed={wide}
          aria-label={wide ? t('Narrow the panel') : t('Widen the panel')} title={wide ? t('Narrow the panel') : t('Widen the panel')}>
          <Icon name={wide ? 'narrow' : 'widen'} size={15} />
        </button>
      )}
      <button type="button" className="drawer-tool" onClick={onClose} aria-label={t('Close panel')} title={t('Close panel')}><Icon name="close" size={16} /></button>
    </div>
  );
  if (docked) {
    return (
      <aside className="drawer drawer-docked" aria-label={label} tabIndex={-1} ref={ref}>
        {tools}
        {children}
      </aside>
    );
  }
  // Focus the panel once when it opens, not the first button in it.
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Theme asChild>
         <div className="drawer-layer">
          <Dialog.Overlay className="drawer-scrim" />
          <Dialog.Content
            className={`drawer${wide ? ' drawer-wide' : ''}`} aria-describedby={undefined} tabIndex={-1} ref={ref}
            onOpenAutoFocus={(e) => { e.preventDefault(); ref.current?.focus({ preventScroll: true }); }}
          >
            <VisuallyHidden.Root asChild><Dialog.Title>{label}</Dialog.Title></VisuallyHidden.Root>
            {tools}
            {children}
          </Dialog.Content>
         </div>
        </Theme>
      </Dialog.Portal>
    </Dialog.Root>
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

/**
 * Radix Button props for the class names callers have always passed (`btn btn-small btn-ghost text-bad`…),
 * so every button in the app is a Radix one: btn-small is size 1, btn-primary solid in the accent, btn-danger
 * solid red, btn-ghost ghost, text-bad red, anything else outline gray. Other classes pass through.
 */
export function buttonLook(className = '') {
  const has = (c) => className.split(/\s+/).includes(c);
  const rest = className.split(/\s+/).filter((c) => c && !['btn', 'btn-small', 'btn-primary', 'btn-ghost', 'btn-danger', 'text-bad'].includes(c)).join(' ');
  const look = { size: has('btn-small') ? '1' : '2' };
  if (has('btn-primary')) look.variant = 'solid';
  else if (has('btn-danger')) Object.assign(look, { variant: 'solid', color: 'red' });
  else Object.assign(look, { variant: has('btn-ghost') ? 'ghost' : 'outline', color: has('text-bad') ? 'red' : 'gray' });
  // Radix pulls a ghost button out by its padding; these sit side by side in rows that count on their box.
  const classes = [rest, look.variant === 'ghost' && 'ghost-boxed'].filter(Boolean).join(' ');
  if (classes) look.className = classes;
  return look;
}

export function ExternalLink({ href, children, className = 'btn btn-ghost btn-small' }) {
  const sourceName = useSourceName();
  if (!href) return null;
  children ??= sourceName(href) === 'GitHub' ? t('Open in GitHub') : t('Open in Azure DevOps');
  const link = (props) => <a {...props} href={href} target="_blank" rel="noreferrer noopener">{children}<span className="ext" aria-hidden="true">↗</span></a>;
  // A plain link when asked for one (className "small"…), else a Radix button wearing the link.
  if (!/\bbtn\b/.test(className)) return link({ className });
  return <Button asChild {...buttonLook(className)}>{link({})}</Button>;
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
    <Collapsible.Root open={open} onOpenChange={setOpen}>
      <div className="filter-fold-bar">
        {lead}
        <Collapsible.Trigger asChild>
          <Button type="button" size="1" variant="outline" color={active ? undefined : 'gray'} className="filter-fold-btn">
            <Icon name="search" size={14} /> {t('Filters')}{active > 0 && <span className="filter-fold-n">{active}</span>}
          </Button>
        </Collapsible.Trigger>
      </div>
      <Collapsible.Content className="filter-fold">{children}</Collapsible.Content>
    </Collapsible.Root>
  );
}

/** A list's sort as a menu, where there are no column headings to tap (phones). `options`: [[key, label]]. */
export function SortPick({ sort, setSort, options }) {
  return (
    <span className="sort-pick">
      <Select value={sort.key} onChange={(e) => setSort({ key: e.target.value, dir: sort.dir })} aria-label={t('Sort by')}>
        {options.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </Select>
      <Button size="1" variant="outline" color="gray" type="button" onClick={() => setSort({ key: sort.key, dir: -sort.dir })} aria-label={sort.dir === 1 ? t('Ascending') : t('Descending')} title={sort.dir === 1 ? t('Ascending') : t('Descending')}>
        {sort.dir === 1 ? '↑' : '↓'}
      </Button>
    </span>
  );
}

// Radix's Select can't hold an empty value (that's its "nothing chosen"), so "" travels as this.
const NONE = '__keel_none__';
const textOf = (node) => Children.toArray(node).map((c) => (typeof c === 'string' || typeof c === 'number' ? String(c) : isValidElement(c) ? textOf(c.props.children) : '')).join('');
function optionsOf(children, out = []) {
  Children.forEach(children, (c) => {
    if (!isValidElement(c)) return;
    if (c.type === Fragment) optionsOf(c.props.children, out);
    else if (c.type === 'optgroup') out.push({ group: c.props.label, items: optionsOf(c.props.children, []) });
    else if (c.type === 'option') out.push({ value: String(c.props.value ?? textOf(c.props.children)), label: c.props.children, disabled: c.props.disabled });
  });
  return out;
}

function LiveSelect({ value, onChange, children, className = '', disabled, required, name, id, title, style, 'aria-label': aria, defaultOpen, autoFocus }) {
  const opts = optionsOf(children);
  const flat = opts.flatMap((o) => (o.group !== undefined ? o.items : [o]));
  const cur = String(value ?? '');
  const has = flat.some((o) => o.value === cur);
  const enc = (v) => (v === '' ? NONE : v);
  const item = (o) => <RtSelect.Item key={o.value} value={enc(o.value)} disabled={o.disabled}>{o.label}</RtSelect.Item>;
  return (
    <RtSelect.Root defaultOpen={defaultOpen} value={has ? enc(cur) : ''} onValueChange={(v) => onChange?.({ target: { value: v === NONE ? '' : v, name } })} disabled={disabled} required={required} name={name}>
      <RtSelect.Trigger autoFocus={autoFocus} id={id} title={title} style={style} aria-label={aria} variant="surface" color="gray" placeholder="—" className={`rt-sel ${className.replace(/\binput(-inline)?\b/g, '').trim()}`} />
      <RtSelect.Content color="gray">
        {opts.map((o, i) => (o.group !== undefined
          ? <RtSelect.Group key={`${o.group}:${i}`}><RtSelect.Label>{o.group}</RtSelect.Label>{o.items.map(item)}</RtSelect.Group>
          : item(o)))}
      </RtSelect.Content>
    </RtSelect.Root>
  );
}

/**
 * Radix Themes' Select behind the shape of a native one: the same value, onChange(e) with
 * e.target.value and <option>s (and <optgroup>s) as children, so a page swaps one for the other.
 * A list can hold a hundred of them (a state and an assignee on every row), and each is a whole
 * Radix tree, so until you point at one, focus it or tap it, it is only its trigger, drawn the same.
 */
export function Select(props) {
  const [live, setLive] = useState(null);
  if (live) return <LiveSelect {...props} defaultOpen={live === 'open'} autoFocus={live === 'focus'} />;
  const { value, children, className = '', disabled, id, title, style, 'aria-label': aria } = props;
  const cur = String(value ?? '');
  const found = optionsOf(children).flatMap((o) => (o.group !== undefined ? o.items : [o])).find((o) => o.value === cur);
  return (
    <button
      type="button" role="combobox" aria-expanded="false" aria-autocomplete="none" dir="ltr" data-accent-color="gray" data-state="closed"
      className={`rt-reset rt-SelectTrigger rt-r-size-2 rt-variant-surface rt-sel ${className.replace(/\binput(-inline)?\b/g, '').trim()}`}
      id={id} title={title} style={style} aria-label={aria} disabled={disabled} data-disabled={disabled ? '' : undefined}
      onPointerEnter={() => setLive('idle')} onFocus={() => setLive('focus')} onClick={() => setLive('open')}
    >
      <span className="rt-SelectTriggerInner"><span style={{ pointerEvents: 'none' }}>{found ? found.label : '—'}</span></span>
      <svg width="9" height="9" viewBox="0 0 9 9" fill="currentcolor" xmlns="http://www.w3.org/2000/svg" className="rt-SelectIcon" aria-hidden="true"><path d="M0.135232 3.15803C0.324102 2.95657 0.640521 2.94637 0.841971 3.13523L4.5 6.56464L8.158 3.13523C8.3595 2.94637 8.6759 2.95657 8.8648 3.15803C9.0536 3.35949 9.0434 3.67591 8.842 3.86477L4.84197 7.6148C4.64964 7.7951 4.35036 7.7951 4.15803 7.6148L0.158031 3.86477C-0.0434285 3.67591 -0.0536285 3.35949 0.135232 3.15803Z" /></svg>
    </button>
  );
}

/** One radio of Radix Themes' RadioGroup, as a native one: checked, and onChange when it's picked. */
export function Radio({ checked, onChange, ...rest }) {
  return (
    <RtRadioGroup.Root value={checked ? 'on' : ''} onValueChange={() => onChange?.()}>
      <RtRadioGroup.Item value="on" {...rest} />
    </RtRadioGroup.Root>
  );
}

/** Radix Themes' Checkbox with a native one's onChange(e): e.target.checked. */
export function Checkbox({ checked, onChange, ...rest }) {
  return <RtCheckbox checked={!!checked} onCheckedChange={(c) => onChange?.({ target: { checked: c === true } })} {...rest} />;
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
    <RxToggle.Root className={`toggle ${checked ? 'on' : ''}`} pressed={checked} onPressedChange={onChange}>
      {children}{count !== undefined && <span className="toggle-count">{count}</span>}
    </RxToggle.Root>
  );
}

/** A short label on hover or focus, beside what it names (the dock's icons). */
export function Tip({ label, side = 'right', children }) {
  return <RtTooltip content={label} side={side}>{children}</RtTooltip>;
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
  return (
    <AlertDialog.Root>
      <AlertDialog.Trigger><Button type="button" {...buttonLook(className)}>{children}</Button></AlertDialog.Trigger>
      <AlertDialog.Content size="1" maxWidth="340px" className="confirm-pop" aria-describedby={undefined}>
        <AlertDialog.Title size="3" mb="0">{text}</AlertDialog.Title>
        <span className="confirm-actions">
          <AlertDialog.Cancel><Button size="2" variant="soft" color="gray" type="button">{t('Cancel')}</Button></AlertDialog.Cancel>
          <AlertDialog.Action><Button size="2" variant="solid" color="red" type="button" onClick={onConfirm}>{t('Yes')}</Button></AlertDialog.Action>
        </span>
      </AlertDialog.Content>
    </AlertDialog.Root>
  );
}
