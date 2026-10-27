// When secrets and certificates run out. Pure.

const DAY = 24 * 60 * 60 * 1000;

/** Milliseconds until `expires` (an ISO time, or ms), negative when it has passed; null when it never expires. */
export function msLeft(expires, now = Date.now()) {
  if (expires == null || expires === '') return null;
  const at = typeof expires === 'number' ? expires : Date.parse(expires);
  return Number.isFinite(at) ? at - now : null;
}

/** Whether it has run out. */
export const isExpired = (item, now = Date.now()) => (msLeft(item?.expires, now) ?? 1) <= 0;

/** Whether it runs out within `days` (or has already). */
export const expiresWithin = (item, days, now = Date.now()) => {
  const left = msLeft(item?.expires, now);
  return left != null && left <= days * DAY;
};

/** The secrets and certificates (`items`) that have run out or run out within `days`, soonest first; disabled ones too, as they still say so. */
export function expiring(items, { days, now = Date.now() } = {}) {
  return (items ?? []).filter((i) => expiresWithin(i, days, now)).sort((a, b) => msLeft(a.expires, now) - msLeft(b.expires, now));
}

/** "expired 3 days ago", "expires today", "expires in 5 days", "never expires". */
export function expiryWords(expires, now = Date.now()) {
  const left = msLeft(expires, now);
  if (left == null) return 'never expires';
  const days = Math.floor(Math.abs(left) / DAY);
  if (left <= 0) return days === 0 ? 'expired today' : `expired ${days} day${days === 1 ? '' : 's'} ago`;
  if (left < DAY) return 'expires today';
  const n = Math.ceil(left / DAY);
  return `expires in ${n} day${n === 1 ? '' : 's'}`;
}

/** A short form for a column: "-3d", "today", "5d", "" for never. */
export function shortExpiry(expires, now = Date.now()) {
  const left = msLeft(expires, now);
  if (left == null) return '';
  if (left <= 0) return `-${Math.max(0, Math.floor(-left / DAY))}d`;
  if (left < DAY) return 'today';
  return `${Math.ceil(left / DAY)}d`;
}

/** The tone of an expiry: del when gone or within a week, warn within `days`, dim otherwise. */
export function expiryTone(expires, days, now = Date.now()) {
  const left = msLeft(expires, now);
  if (left == null) return 'dim';
  if (left <= 7 * DAY) return 'del';
  return left <= days * DAY ? 'warn' : 'dim';
}

/** The line a notification says when something is about to run out: "2 secrets in kv-shop expire within 30 days: Stripe--ApiKey in 5 days, …". */
export function expiryNotice(list, { vault, days, now = Date.now() } = {}) {
  if (!list?.length) return null;
  const gone = list.filter((i) => isExpired(i, now)).length;
  const what = `${list.length} ${list.length === 1 ? 'secret or certificate' : 'secrets and certificates'}${vault ? ` in ${vault}` : ''}`;
  const one = list.length === 1;
  const head = gone === list.length ? `${what} ${one ? 'has' : 'have'} expired` : `${what} ${gone ? 'have expired or ' : ''}${one ? 'expires' : 'expire'} within ${days} days`;
  const first = list.slice(0, 3).map((i) => `${i.name} ${expiryWords(i.expires, now).replace(/^expires /, '')}`);
  return `${head}: ${first.join(', ')}${list.length > 3 ? ', …' : ''}`;
}
