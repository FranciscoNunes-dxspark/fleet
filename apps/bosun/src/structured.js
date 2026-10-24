// Structured logs: a line that is a JSON object (pino, bunyan, Serilog's compact format, winston, or
// anything with a level, a message and a time) read as { time, level, message, fields }, drawn as
// `time level message key=value…`, and the log's filter (`level>=warn`, `field=value`, words). Pure.
import { isTrouble } from './crew.js';

export const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
const RANK = Object.fromEntries(LEVELS.map((l, i) => [l, i]));

const WORDS = {
  trace: 'trace', verbose: 'trace', vrb: 'trace', silly: 'trace', trc: 'trace',
  debug: 'debug', dbg: 'debug', dbug: 'debug',
  info: 'info', information: 'info', inf: 'info', notice: 'info', http: 'info',
  warn: 'warn', warning: 'warn', wrn: 'warn',
  error: 'error', err: 'error', eror: 'error',
  fatal: 'fatal', ftl: 'fatal', critical: 'fatal', crit: 'fatal', emerg: 'fatal', emergency: 'fatal', alert: 'fatal', panic: 'fatal',
};

/** A level as the loggers write it (pino's and bunyan's numbers, words in any case) as one of LEVELS, or null. */
export function levelName(value) {
  if (typeof value === 'number') return value <= 10 ? 'trace' : value <= 20 ? 'debug' : value <= 30 ? 'info' : value <= 40 ? 'warn' : value <= 50 ? 'error' : 'fatal';
  if (typeof value !== 'string') return null;
  if (/^\d+$/.test(value)) return levelName(Number(value));
  return WORDS[value.trim().toLowerCase()] ?? null;
}

/** The theme colour a level is drawn in (a key of theme.js's theme): dim for trace and debug, red for error and fatal. */
export const levelTone = (level) => ({ trace: 'dim', debug: 'dim', info: 'info', warn: 'warn', error: 'del', fatal: 'del' })[level];

/** Whether `level` is at least `least` (both LEVELS names). */
export const atLeast = (level, least) => level != null && RANK[level] >= RANK[least];

// Fields every line of a logger carries, which say nothing about this one.
const NOISE = new Set(['v', 'pid', 'hostname', 'host']);
const TIME = ['time', 'timestamp', 'ts', '@timestamp', 't', 'date', 'datetime'];
const LEVEL = ['level', 'lvl', 'severity', 'loglevel', 'log.level', 'levelname'];
const MESSAGE = ['msg', 'message', '@message', 'text'];

const first = (obj, keys) => keys.find((k) => obj[k] != null && obj[k] !== '');

/** A time as the loggers write it (epoch ms or seconds, ISO text) as ms, or null. */
export function timeOf(value) {
  if (typeof value === 'number') return value > 1e11 ? value : value * 1000;
  if (typeof value !== 'string') return null;
  const n = Date.parse(value);
  return Number.isNaN(n) ? null : n;
}

// Serilog's message template, filled in from the event: {Name}, {@Name}, {$Name}, {Name:format}.
const renderTemplate = (template, obj) =>
  String(template).replace(/\{\{|\}\}|\{[@$]?([\w.]+)(?:[,:][^}]*)?\}/g, (m, name) => (m === '{{' ? '{' : m === '}}' ? '}' : obj[name] === undefined ? m : typeof obj[name] === 'string' ? obj[name] : JSON.stringify(obj[name])));

/**
 * `text` as a structured line: { obj, time (ms or null), level (a LEVELS name or null), message,
 * fields: [[key, value]] }, or null when it isn't a JSON object with a level or a message.
 */
export function parseStructured(text) {
  const t = String(text ?? '').trim();
  if (t[0] !== '{' || t.at(-1) !== '}') return null;
  let obj;
  try {
    obj = JSON.parse(t);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  // Serilog's compact JSON: @t, @l (Information when missing), @m or @mt, @x.
  if ('@t' in obj || '@m' in obj || '@mt' in obj) {
    const fields = Object.entries(obj).filter(([k]) => !k.startsWith('@'));
    if (obj['@x']) fields.push(['exception', String(obj['@x']).split(/\r?\n/)[0]]);
    return { obj, time: timeOf(obj['@t']), level: levelName(obj['@l'] ?? 'Information'), message: String(obj['@m'] ?? renderTemplate(obj['@mt'] ?? '', obj)), fields };
  }
  const levelKey = first(obj, LEVEL);
  const messageKey = first(obj, MESSAGE);
  const level = levelKey ? levelName(obj[levelKey]) : null;
  if (!level && !messageKey) return null;
  const timeKey = first(obj, TIME);
  const used = new Set([levelKey, messageKey, timeKey]);
  const fields = Object.entries(obj).filter(([k]) => !used.has(k) && !NOISE.has(k));
  return { obj, time: timeKey ? timeOf(obj[timeKey]) : null, level, message: messageKey ? String(obj[messageKey]) : '', fields };
}

// Each line object is read once, however often it's drawn.
const cache = new WeakMap();

/** A supervisor line ({ text, at, err }) read as structured (parseStructured's), or null; kept per line. */
export function structuredOf(line) {
  if (!line || typeof line !== 'object') return parseStructured(line);
  if (!cache.has(line)) cache.set(line, parseStructured(line.text));
  return cache.get(line);
}

const two = (n) => String(n).padStart(2, '0');

/** A time as the log shows it: 14:03:07.120, in this machine's time zone. */
export function clockOf(ms) {
  const d = new Date(ms);
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

/** A field's value as `key=value` shows it: text as it is (quoted when it has spaces), an error as its message, the rest as JSON. */
export function fieldText(value) {
  if (typeof value === 'string') return /[\s"=]/.test(value) || !value ? JSON.stringify(value) : value;
  if (value && typeof value === 'object' && typeof value.message === 'string') return JSON.stringify(`${value.type ?? value.name ?? 'Error'}: ${value.message}`);
  return JSON.stringify(value);
}

const oneLine = (s) => String(s).replace(/\r?\n/g, ' ⏎ ');

/**
 * A structured line as it's drawn: parts { text, kind } (kind time, level, message or fields) and
 * `text`, them all joined: `14:03:07.120 WARN  slow query ms=812 route=/orders`.
 */
export function formatStructured(s) {
  const parts = [];
  if (s.time != null) parts.push({ text: `${clockOf(s.time)} `, kind: 'time' });
  if (s.level) parts.push({ text: `${s.level.toUpperCase().padEnd(5)} `, kind: 'level' });
  parts.push({ text: oneLine(s.message), kind: 'message' });
  const fields = s.fields.map(([k, v]) => `${k}=${oneLine(fieldText(v))}`).join(' ');
  if (fields) parts.push({ text: `${s.message ? ' ' : ''}${fields}`, kind: 'fields' });
  return { parts, text: parts.map((p) => p.text).join('') };
}

/** A line's text as the log shows it: a structured one formatted, else as it came. */
export const shownText = (line) => {
  const s = structuredOf(line);
  return s ? formatStructured(s).text : line.text;
};

/** Whether a line reads as trouble: a structured one at error or worse, else crew.js's words. */
export const troubled = (line) => {
  const s = structuredOf(line);
  return s?.level ? atLeast(s.level, 'error') : isTrouble(line.text);
};

/** A field of the object by its dotted path (`req.url`), or the message for msg/message. */
function fieldOf(s, key) {
  if (key === 'msg' || key === 'message') return s.message;
  if (key in s.obj) return s.obj[key];
  let v = s.obj;
  for (const part of key.split('.')) {
    if (v == null || typeof v !== 'object') return undefined;
    v = v[part];
  }
  return v;
}

const valueText = (v) => (typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v));
const OPS = { '>=': (a, b) => a >= b, '<=': (a, b) => a <= b, '>': (a, b) => a > b, '<': (a, b) => a < b, '=': (a, b) => a === b, '==': (a, b) => a === b, '!=': (a, b) => a !== b };

/**
 * The log's filter from what was typed: `level>=warn` (and <=, >, <, =, !=), `field=value`,
 * `field!=value`, `field~part` (case doesn't matter), and words the line must hold (smart case:
 * any capital makes it exact). Terms are separated by spaces, all must hold; "quotes" keep spaces in.
 * Returns { text, terms, problems }.
 */
export function parseFilter(input) {
  const text = String(input ?? '').trim();
  const terms = [];
  const problems = [];
  for (const raw of text.match(/[^\s"]*"[^"]*"?|\S+/g) ?? []) {
    const token = raw.replace(/"/g, '');
    const lvl = /^(level|lvl)\s*(>=|<=|==|!=|=|>|<)\s*(\w+)$/i.exec(token);
    if (lvl) {
      const level = levelName(lvl[3]);
      if (level) terms.push({ type: 'level', op: lvl[2], level });
      else problems.push(`${lvl[3]} isn't a level (${LEVELS.join(', ')})`);
      continue;
    }
    const field = /^([A-Za-z_@$][\w.@$-]*)(!=|=|~)(.*)$/.exec(token);
    if (field) {
      terms.push({ type: 'field', key: field[1], op: field[2], value: field[3] });
      continue;
    }
    if (token) terms.push({ type: 'text', value: token, exact: token !== token.toLowerCase() });
  }
  return { text, terms, problems };
}

/** Whether `line` passes `filter` (parseFilter's): every term holds. A plain line has no fields, and its level is error when it reads as trouble. */
export function passes(filter, line) {
  if (!filter?.terms.length) return true;
  const s = structuredOf(line);
  const shown = s ? formatStructured(s).text : line.text;
  for (const t of filter.terms) {
    if (t.type === 'text') {
      if (!(t.exact ? shown.includes(t.value) || line.text.includes(t.value) : shown.toLowerCase().includes(t.value) || line.text.toLowerCase().includes(t.value))) return false;
    } else if (t.type === 'level') {
      const level = s?.level ?? (isTrouble(line.text) ? 'error' : null);
      if (level == null || !OPS[t.op](RANK[level], RANK[t.level])) return false;
    } else {
      if (!s) return false;
      const v = valueText(fieldOf(s, t.key)).toLowerCase();
      const want = t.value.toLowerCase();
      if (t.op === '~' ? !v.includes(want) : t.op === '=' ? v !== want : v === want) return false;
    }
  }
  return true;
}

/** The trouble in a line of text as the list says it (a structured one formatted, when it's at error or worse), or null. */
export function troubleText(text) {
  const s = parseStructured(text);
  if (s?.level) return atLeast(s.level, 'error') ? formatStructured(s).text : null;
  return isTrouble(text) ? String(text).trim() : null;
}
