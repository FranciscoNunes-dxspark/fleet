// What a server's error page says, for the log when a health page answers 5xx: ASP.NET's yellow
// screen (.NET Framework: the exception, where it was thrown and its stack), ASP.NET Core's developer
// exception page, IIS's detailed errors (500.19, 500.30…), a problem details JSON, or the page's
// title. Often the only place the error is written down at all. Pure.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

/** HTML's text: tags out, entities in, spaces squeezed (unless `squeeze` is false: a stack's indents). */
export function htmlText(html, { squeeze = true } = {}) {
  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e.toLowerCase()] ?? m)))
    .replace(squeeze ? /[ \t]+/g : /\t/g, squeeze ? ' ' : '    ');
}

const one = (s) => htmlText(s).replace(/\s+/g, ' ').trim();

// The most stack lines the log gets: the top of it is what tells.
const STACK = 12;

/**
 * An error page as { headline, lines }: the headline the exception or the error (`NullReferenceException:
 * Object reference not set…`), the lines where it was and its stack. Null when there's nothing to say.
 */
export function errorPage(body) {
  const text = String(body ?? '');
  if (!text.trim()) return null;
  // Problem details, or any JSON with a title or a message.
  if (/^\s*[{[]/.test(text)) {
    try {
      const o = JSON.parse(text);
      const headline = [o.title, o.detail ?? o.message ?? o.error].filter((x) => typeof x === 'string' && x).join(': ');
      if (headline) return { headline, lines: typeof o.exception === 'string' ? o.exception.split(/\r?\n/).slice(0, STACK) : [] };
    } catch {
      // Not JSON after all.
    }
  }
  // ASP.NET's yellow screen (.NET Framework).
  const details = /Exception Details:\s*<\/b>([\s\S]*?)(?:<br|<\/td>)/i.exec(text)?.[1];
  if (details) {
    const lines = [];
    const source = /Source File:\s*<\/b>([\s\S]*?)<b>[\s\S]*?Line:\s*<\/b>\s*(\d+)/i.exec(text);
    if (source) lines.push(`at ${one(source[1])}:${source[2]}`);
    const stack = /Stack Trace:[\s\S]*?<pre>([\s\S]*?)<\/pre>/i.exec(text)?.[1];
    if (stack) lines.push(...htmlText(stack, { squeeze: false }).split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim()).slice(0, STACK));
    return { headline: one(details), lines };
  }
  // customErrors on: the yellow screen that says nothing.
  if (/<title>\s*Runtime Error\s*<\/title>/i.test(text) && /customErrors/i.test(text)) {
    return { headline: 'Runtime Error (the site\'s customErrors hide it)', lines: ['set <customErrors mode="RemoteOnly" /> in its web.config: Bosun asks from this machine, which then sees the error'] };
  }
  // ASP.NET Core's developer exception page.
  const core = /class="titleerror"[^>]*>([\s\S]*?)<\/div>/i.exec(text)?.[1];
  if (core) {
    const lines = [...text.matchAll(/class="location"[^>]*>([\s\S]*?)<\/(?:p|div)>/gi)].map((m) => `at ${one(m[1])}`).slice(0, STACK);
    return { headline: one(core), lines };
  }
  // IIS's detailed error page: HTTP Error 500.19 and what it means.
  const h3 = /<h3>([\s\S]*?)<\/h3>/i.exec(text)?.[1];
  if (h3 && /HTTP Error/i.test(h3)) {
    const lines = [];
    const h4 = /<h4>([\s\S]*?)<\/h4>/i.exec(text)?.[1];
    if (h4) lines.push(one(h4));
    for (const [, label, value] of text.matchAll(/<th>([^<]*)<\/th>\s*<td>([\s\S]*?)<\/td>/gi)) if (/Module|Notification|Handler|Error Code|Config Error|Config File/i.test(label)) lines.push(`${one(label)} ${one(value)}`);
    const config = /Config Error<\/legend>[\s\S]*?<td>([\s\S]*?)<\/td>/i.exec(text)?.[1];
    if (config && !lines.some((l) => l.startsWith('Config Error'))) lines.push(`Config Error: ${one(config)}`);
    return { headline: one(h3), lines };
  }
  const title = /<title>([\s\S]*?)<\/title>/i.exec(text)?.[1];
  if (title && one(title)) return { headline: one(title), lines: [] };
  const first = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  return first && !first.startsWith('<') ? { headline: first.slice(0, 300), lines: [] } : null;
}
