// Sizes, rates, durations and dates as the panes and the queue show them, pure.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 1536 → "1.5 KB": one decimal below ten, none above; bytes plain. */
export function sizeText(bytes) {
  if (bytes == null || Number.isNaN(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit++;
  } while (value >= 1024 && unit < 3);
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${['KB', 'MB', 'GB', 'TB'][unit]}`;
}

/** Bytes per second as "1.2 MB/s". */
export const rateText = (perSecond) => (perSecond > 0 ? `${sizeText(Math.round(perSecond))}/s` : '');

/** Seconds as "5s", "2m 03s", "1h 02m". */
export function durationText(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** A modification time as `ls` writes it: "Oct 30 10:00" this year, "Oct 30  2025" before. */
export function dateText(ms, now = Date.now()) {
  if (ms == null) return '';
  const d = new Date(ms);
  const day = String(d.getDate()).padStart(2, ' ');
  if (d.getFullYear() === new Date(now).getFullYear()) return `${MONTHS[d.getMonth()]} ${day} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${MONTHS[d.getMonth()]} ${day}  ${d.getFullYear()}`;
}

/** A percentage 0–100 from bytes over total; null when the total isn't known. */
export const percentOf = (bytes, total) => (total > 0 ? Math.min(100, Math.floor((bytes / total) * 100)) : total === 0 ? 100 : null);
