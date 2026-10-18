// Translations for text the server writes itself and sends elsewhere (Teams
// and Slack posts). Same dictionaries as the console (client/src/locales), and
// the same rules as client/src/i18n.js: t() for Keel's own sentences, tx() for
// server sentences, which also match templates like 'Open {age} (stale)'.
import pt, { serverText as ptServer } from '../client/src/locales/pt.js';

export const LANGUAGES = { en: 'en-GB', pt: 'pt-PT' };
const DICTS = { pt };
const SERVER = { pt: ptServer };

const fill = (text, params) => (params ? text.replace(/\{(\w+)\}/g, (m, k) => (params[k] ?? m)) : text);
export const localeOf = (lang) => LANGUAGES[lang] || LANGUAGES.en;

/** A translator for one language: { t, tx, locale }. */
export function translator(lang = 'en') {
  const dict = DICTS[lang] || null;
  const own = SERVER[lang] || {};
  const templates = Object.keys(own)
    .filter((k) => /\{\w+\}/.test(k))
    .map((k) => {
      const names = [];
      const source = k.split(/(\{\w+\})/).map((part) => {
        const m = part.match(/^\{(\w+)\}$/);
        if (!m) return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        names.push(m[1]);
        return '(.+?)';
      }).join('');
      return { re: new RegExp(`^${source}$`), names, out: own[k] };
    })
    .sort((a, b) => b.re.source.length - a.re.source.length);

  const t = (text, params) => fill((dict && dict[text]) || text, params);
  const tx = (text) => {
    if (!dict || typeof text !== 'string' || !text) return text;
    if (own[text]) return own[text];
    if (dict[text]) return dict[text];
    for (const { re, names, out } of templates) {
      const m = text.match(re);
      if (m) return fill(out, Object.fromEntries(names.map((n, i) => [n, own[m[i + 1]] || dict[m[i + 1]] || m[i + 1]])));
    }
    return text;
  };
  return { t, tx, locale: localeOf(lang) };
}
