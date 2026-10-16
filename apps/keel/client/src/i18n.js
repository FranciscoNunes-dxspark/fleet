// Languages: English (the source text) and European Portuguese.
//
// t('Save changes')                      UI text. The English text is the key; missing keys show in English.
// t('{n} need attention', { n })         {name} placeholders are filled from params.
// tj('Pick {link} to start.', { link })  same, for text with React elements inside (returns an array).
// tx(text)                               text the server sent (Inbox reasons, errors, notifications):
//                                        exact match first, then templates such as 'Open {days}d (stale)'.
//
// The choice is saved per account (synced like the theme) with a copy in this
// browser; the default follows the browser's language. Changing it re-renders
// the app (App.jsx listens for "keel:language").
import { Fragment, createElement } from 'react';
// Only pushPref (a function) is used from prefs.js, and only after startup:
// prefs.js -> api.js -> i18n.js is a cycle, so its constants can't be read here.
import { pushPref } from './prefs.js';
import pt, { serverText as ptServer } from './locales/pt.js';

export const LANGUAGES = [
  { id: 'en', label: 'English', locale: 'en-GB' },
  { id: 'pt', label: 'Português', locale: 'pt-PT' },
];
const DICTS = { pt };
// Templates for tx() come only from server text, so a UI key like '{age} ago' never rewrites a server sentence.
const SERVER_DICTS = { pt: ptServer };
const KEY = 'keel.language.v1'; // = PREF_KEYS.language

const browserDefault = () => (/^pt\b/i.test(navigator.language || '') ? 'pt' : 'en');
const valid = (id) => LANGUAGES.some((l) => l.id === id);

function saved() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || 'null');
    return valid(v?.lang) ? v.lang : null;
  } catch {
    return null;
  }
}

let current = saved() || browserDefault();
document.documentElement.lang = current;

export const getLanguage = () => current;
/** The locale for dates and numbers (Intl). */
export const locale = () => LANGUAGES.find((l) => l.id === current).locale;

/** Switch language (from Settings or the account's synced prefs). */
export function setLanguage(id, { sync = true } = {}) {
  if (!valid(id)) return;
  try {
    localStorage.setItem(KEY, JSON.stringify({ lang: id }));
  } catch {
    // Storage blocked: lasts for this visit.
  }
  if (sync) pushPref('language', { lang: id });
  if (id === current) return;
  current = id;
  document.documentElement.lang = id;
  window.dispatchEvent(new CustomEvent('keel:language', { detail: id }));
}

/** Re-read the browser copy (after the account's prefs were adopted). */
export function applySavedLanguage() {
  const id = saved();
  if (id && id !== current) setLanguage(id, { sync: false });
}

const fill = (text, params) => (params ? text.replace(/\{(\w+)\}/g, (m, k) => (params[k] ?? m)) : text);

export function t(text, params) {
  const dict = DICTS[current];
  return fill((dict && dict[text]) || text, params);
}

/** t() for text with elements inside: placeholders whose param is a React element are kept as nodes. */
export function tj(text, params = {}) {
  const dict = DICTS[current];
  const parts = ((dict && dict[text]) || text).split(/(\{\w+\})/);
  return parts.map((part, i) => {
    const m = part.match(/^\{(\w+)\}$/);
    const value = m ? params[m[1]] : part;
    return createElement(Fragment, { key: i }, value ?? part);
  });
}

// Templates: keys with placeholders, compiled once per language into regexes
// that match the server's English output.
const compiled = {};
function templates() {
  if (!compiled[current]) {
    const dict = SERVER_DICTS[current] || {};
    compiled[current] = Object.keys(dict)
      .filter((k) => /\{\w+\}/.test(k))
      .map((k) => {
        const names = [];
        const source = k.split(/(\{\w+\})/).map((part) => {
          const m = part.match(/^\{(\w+)\}$/);
          if (!m) return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          names.push(m[1]);
          return '(.+?)';
        }).join('');
        return { re: new RegExp(`^${source}$`), names, out: dict[k] };
      })
      // Longer templates first, so the most specific one wins.
      .sort((a, b) => b.re.source.length - a.re.source.length);
  }
  return compiled[current];
}

const txCache = new Map();
/** Text the server wrote in English, shown in the current language when a translation exists. */
export function tx(text) {
  if (typeof text !== 'string' || !text || current === 'en') return text;
  const dict = DICTS[current];
  // Server text: its own dictionary first, so a word like "unstable" keeps the server's sense.
  const own = SERVER_DICTS[current] || {};
  if (own[text]) return own[text];
  if (dict[text]) return dict[text];
  const cacheKey = `${current}\u0000${text}`;
  if (txCache.has(cacheKey)) return txCache.get(cacheKey);
  let out = text;
  for (const { re, names, out: target } of templates()) {
    const m = text.match(re);
    if (m) {
      // Captured values may themselves be translatable (e.g. a state word).
      out = fill(target, Object.fromEntries(names.map((n, i) => [n, own[m[i + 1]] || dict[m[i + 1]] || m[i + 1]])));
      break;
    }
  }
  if (txCache.size > 2000) txCache.clear();
  txCache.set(cacheKey, out);
  return out;
}
