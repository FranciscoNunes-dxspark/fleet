import { locale, t } from './i18n.js';

const HOUR = 3_600_000;

export function age(iso, now = Date.now()) {
  if (!iso) return '—';
  return hours((now - Date.parse(iso)) / HOUR);
}

export function hours(h) {
  if (h == null || !Number.isFinite(h)) return '—';
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m`;
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

export function date(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(locale(), { month: 'short', day: 'numeric' });
}

export function dateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(locale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);

export const initials = (name = '') => name
  .replace(/\(.*?\)/g, '')
  .split(/\s+/)
  .filter(Boolean)
  .slice(0, 2)
  .map((s) => s[0]?.toUpperCase())
  .join('') || '?';

export const VOTES = {
  10: { get label() { return t('Approved'); }, tone: 'ok', glyph: '✓' },
  5: { get label() { return t('Approved with suggestions'); }, tone: 'ok', glyph: '✓' },
  0: { get label() { return t('No vote yet'); }, tone: 'none', glyph: '' },
  '-5': { get label() { return t('Waiting for author'); }, tone: 'warn', glyph: '…' },
  '-10': { get label() { return t('Rejected'); }, tone: 'bad', glyph: '✕' },
};

export const REVIEW_STATE = {
  draft: { get label() { return t('Draft'); }, tone: 'muted' },
  rejected: { get label() { return t('Rejected'); }, tone: 'bad' },
  'waiting-author': { get label() { return t('Waiting on author'); }, tone: 'warn' },
  'no-reviewers': { get label() { return t('No reviewers'); }, tone: 'bad' },
  approved: { get label() { return t('Approved'); }, tone: 'ok' },
  'in-review': { get label() { return t('In review'); }, tone: 'info' },
};

// Mirrors server/domain/attention.js: CMMI flag, a tag, or a custom state named like the tag.
export const isBlocked = (w, blockedTag) => {
  const name = String(blockedTag || '').toLowerCase();
  return w.blocked || (!!name && (w.state?.toLowerCase() === name || w.tags.some((tag) => tag.toLowerCase() === name)));
};

export const shortIteration =(path) => (path ? path.split('\\').pop() : '');
