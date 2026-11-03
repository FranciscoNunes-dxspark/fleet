// What a page's HTML says, read from its text when there's no browser to ask: the same facts browser.js
// reads from the DOM (title, description, canonical, robots, lang, images, links, what blocks the first
// paint), so audit.js judges them alike. Pure, and only as good as a read of the markup can be: what
// scripts add later isn't there.

const decode = (s) => String(s ?? '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
const attr = (tag, name) => {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? decode(m[1] ?? m[2] ?? m[3] ?? '') : null;
};
const tags = (html, name) => [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'gi'))].map((m) => m[0]);
const abs = (href, base) => {
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
};

/** The facts of `html` served at `url`. */
export function htmlFacts(html, url) {
  const text = String(html ?? '').replace(/<!--[\s\S]*?-->/g, '');
  const head = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(text)?.[1] ?? '';
  const meta = (name) => {
    const t = tags(text, 'meta').find((m) => (attr(m, 'name') ?? '').toLowerCase() === name);
    return t ? attr(t, 'content') : null;
  };
  const canonical = tags(text, 'link').find((l) => /(^|\s)canonical(\s|$)/i.test(attr(l, 'rel') ?? ''));
  const html0 = tags(text, 'html')[0];
  return {
    title: decode(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(text)?.[1] ?? '') || null,
    description: meta('description'),
    robots: meta('robots'),
    viewport: meta('viewport'),
    canonical: canonical ? abs(attr(canonical, 'href'), url) : null,
    lang: html0 ? attr(html0, 'lang') : null,
    h1: tags(text, 'h1').length,
    images: tags(text, 'img').slice(0, 200).map((t, i) => ({ src: abs(attr(t, 'src') ?? '', url), selector: attr(t, 'id') ? `#${attr(t, 'id')}` : `img:nth-of-type(${i + 1})`, width: attr(t, 'width'), height: attr(t, 'height'), styled: /width\s*:[^;]+;[^"']*height\s*:|aspect-ratio/i.test(attr(t, 'style') ?? ''), lazy: (attr(t, 'loading') ?? '') === 'lazy' })),
    links: [...new Set(tags(text, 'a').map((t) => attr(t, 'href')).filter(Boolean).map((h) => abs(h, url)).filter((h) => h && /^https?:/.test(h)).map((h) => h.split('#')[0]))].slice(0, 300),
    blocking: [
      ...tags(head, 'script').filter((t) => attr(t, 'src') && !/\s(async|defer)\b/i.test(t) && (attr(t, 'type') ?? '') !== 'module').map((t) => ({ kind: 'script', url: abs(attr(t, 'src'), url) })),
      ...tags(head, 'link').filter((t) => /stylesheet/i.test(attr(t, 'rel') ?? '') && (!attr(t, 'media') || attr(t, 'media') === 'all')).map((t) => ({ kind: 'stylesheet', url: abs(attr(t, 'href'), url) })),
    ],
  };
}
