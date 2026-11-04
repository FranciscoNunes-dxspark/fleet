// A .cshtml file read for what it pulls in and what it marks up: its model and layout, the partials,
// child actions, view components and templates it renders, the sections it defines and renders, the
// scripts, styles and bundles it loads, the CSS classes, ids and data- attributes on its elements,
// the JavaScript its event attributes call, and the controllers and actions it links or posts to.
// Inline <script> and <style> blocks are read by the script and style parsers, with their lines kept.
// Regular expressions over the text, not a Razor compiler: a dynamic name (`Html.Partial(name)`)
// isn't followed, and the index reports it as such.
import { callArgs, isToken, lineIndex, literals, matchBrace, stripRazorComments } from '../text.js';
import { parseScript, urlOf } from './script.js';
import { parseStyle } from './style.js';
import { findWidgets } from './widgets.js';

export { callArgs };

/** `new { area = "Admin", controller = "X" }` → { area: 'Admin', controller: 'X' }. */
function routeValues(text) {
  const out = {};
  for (const m of (text ?? '').matchAll(/\b(area|controller|action)\s*=\s*"([^"]*)"/gi)) out[m[1].toLowerCase()] = m[2];
  return out;
}

/** An attribute's value starting at the quote at `i`, Razor expressions with their own quotes included. */
function attrValue(text, i) {
  const q = text[i];
  if (q !== '"' && q !== "'") {
    const m = /^[^\s>]+/.exec(text.slice(i));
    return { value: m ? m[0] : '', end: i + (m ? m[0].length : 0) };
  }
  let depth = 0;
  let j = i + 1;
  for (; j < text.length; j++) {
    const c = text[j];
    if (c === '(' && (depth > 0 || text[j - 1] === '@' || /\w/.test(text[j - 1] ?? ''))) depth++;
    else if (c === ')' && depth > 0) depth--;
    else if (depth > 0 && (c === '"' || c === "'")) {
      const inner = c;
      j++;
      while (j < text.length && text[j] !== inner && text[j] !== '\n') j++;
    } else if (c === q && depth === 0) break;
    else if (c === '\n' && j - i > 600) break;
  }
  return { value: text.slice(i + 1, j), end: j + 1 };
}

/** The class names in a `class` attribute's value: its plain words and the literals inside its Razor. */
export function classTokens(value) {
  const out = new Set();
  // Razor inside the value: @(…), @Model.X, @if…; its string literals may be classes ("active").
  const razor = [];
  const plain = value.replace(/@\((?:[^()]|\([^()]*\))*\)|@[\w.]+(?:\([^)]*\))?/g, (m) => {
    razor.push(m);
    return ' ';
  });
  for (const w of plain.split(/\s+/)) if (isToken(w)) out.add(w);
  for (const r of razor) for (const lit of literals(r)) for (const w of lit.split(/\s+/)) if (isToken(w)) out.add(w);
  return [...out];
}

/** A Razor URL attribute's value as a path: `@Url.Content("~/x")` → `~/x`; anything still dynamic → null. */
export function staticUrl(value) {
  let v = value.trim();
  const content = /^@(?:Url\.Content|Href)\(\s*"([^"]+)"\s*\)$/.exec(v);
  if (content) v = content[1];
  if (!v || /[@{}]/.test(v)) return null;
  return v;
}

const tagAttrs = (tag) => {
  const attrs = {};
  const re = /([\w:@.-]+)\s*=\s*/g;
  let m;
  while ((m = re.exec(tag))) {
    const { value, end } = attrValue(tag, m.index + m[0].length);
    attrs[m[1].toLowerCase()] = value;
    re.lastIndex = end;
  }
  return attrs;
};

const kebabToPascal = (s) => s.replace(/(^|-)([a-z0-9])/g, (_, __, c) => c.toUpperCase());

export function parseRazor(source) {
  const text = stripRazorComments(source);
  const lineOf = lineIndex(text);
  const out = {
    model: null,
    layout: undefined,
    title: null,
    partials: [],
    actions: [],
    components: [],
    sections: [],
    renderSections: [],
    renderBody: 0,
    scripts: [],
    styles: [],
    bundles: [],
    classes: [],
    ids: [],
    attrs: [],
    handlers: [],
    links: [],
    calls: [],
    widgets: [],
    inlineStyles: [],
    a11y: [],
    modelUses: [],
    texts: [],
    localized: 0,
    images: [],
    inline: { script: null, style: null },
    dynamic: [],
  };
  const at = (offset) => lineOf(offset);

  const model = /^\s*@model\s+([^\r\n]+?)\s*$/m.exec(text);
  if (model) out.model = { type: model[1], line: at(model.index) };
  const layout = /\bLayout\s*=\s*(?:"([^"]*)"|(null))\s*;/.exec(text);
  if (layout) out.layout = { value: layout[2] ? null : layout[1], line: at(layout.index) };
  const title = /(?:ViewBag\.Title|ViewData\[\s*"Title"\s*\])\s*=\s*"([^"]*)"/.exec(text);
  if (title) out.title = title[1];

  // Where the inline scripts are: a link written inside one (var url = '@Url.Action("Row")') is a call.
  const scriptRanges = [...text.matchAll(/<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => [at(m.index), at(m.index + m[0].length)]);
  const inScript = (line) => scriptRanges.some(([a, b]) => line >= a && line <= b);

  // Partials, templates, child actions, components: the Html helpers and their tag-helper forms.
  for (const m of text.matchAll(/\b(Html\.(?:Render)?Partial(?:Async)?|RenderPage|Html\.(?:Render)?Action|Html\.(?:Editor|Display)(?:For)?(?:Model)?|Component\.InvokeAsync|Component\.Invoke|Url\.Action|Html\.ActionLink|Html\.BeginForm|Ajax\.BeginForm|Ajax\.ActionLink|Html\.BeginRouteForm)\s*(<\s*(\w+)\s*>)?\s*\(/g)) {
    const via = m[1];
    const line = at(m.index);
    const { args } = callArgs(text, m.index + m[0].length - 1);
    const lit = (n) => args[n]?.literal ?? null;
    if (/Partial|RenderPage/.test(via)) {
      if (lit(0) != null) out.partials.push({ name: lit(0), line, via });
      else out.dynamic.push({ what: `${via}(${args[0]?.text ?? ''})`, line });
    } else if (/^Html\.(Editor|Display)/.test(via)) {
      // EditorFor(m => m.X, "Template") / Editor("X", "Template") / EditorForModel("Template")
      const forModel = /Model$/.test(via);
      const name = forModel ? lit(0) : lit(1);
      if (name) out.partials.push({ name, line, via, template: /Editor/.test(via) ? 'EditorTemplates' : 'DisplayTemplates' });
    } else if (/^Html\.(Render)?Action$/.test(via)) {
      const values = routeValues(args.slice(1).map((a) => a.text).join(','));
      if (lit(0)) out.actions.push({ action: lit(0), controller: lit(1) ?? values.controller ?? null, area: values.area ?? null, line, via });
      else out.dynamic.push({ what: `${via}(${args[0]?.text ?? ''})`, line });
    } else if (/^Component\./.test(via)) {
      const typed = m[3] ?? /typeof\(\s*(\w+)\s*\)/.exec(args[0]?.text ?? '')?.[1];
      const name = lit(0) ?? (typed ? typed.replace(/ViewComponent$/, '') : null);
      if (name) out.components.push({ name, line });
      else out.dynamic.push({ what: `${via}(${args[0]?.text ?? ''})`, line });
    } else {
      // Links and forms: Url.Action(action, controller), ActionLink(text, action, controller), BeginForm(action, controller).
      const first = /ActionLink/.test(via) ? 1 : 0;
      if (via === 'Html.BeginRouteForm') continue;
      const all = args.map((a) => a.text).join(',');
      const values = routeValues(all);
      const action = lit(first);
      if (!action) continue;
      const link = { action, controller: lit(first + 1) ?? values.controller ?? null, area: values.area ?? null, line, via };
      if (/^Ajax\./.test(via)) {
        // Ajax.BeginForm / Ajax.ActionLink: a request whose answer replaces UpdateTargetId.
        const target = /UpdateTargetId\s*=\s*"([^"]+)"/.exec(all)?.[1];
        const method = /HttpMethod\s*=\s*"(\w+)"/.exec(all)?.[1]?.toUpperCase() ?? (/BeginForm/.test(via) ? 'POST' : 'GET');
        out.calls.push({ ...link, method, ...(target ? { target: `#${target}` } : {}) });
      } else if (via === 'Url.Action' && inScript(line)) out.calls.push({ ...link, method: null, via: 'script' });
      else out.links.push(link);
    }
  }
  for (const m of text.matchAll(/<partial\b([^>]*)>/g)) {
    const attrs = tagAttrs(m[1]);
    const name = attrs.name ?? attrs.for;
    if (name && !name.startsWith('@')) out.partials.push({ name, line: at(m.index), via: '<partial>' });
  }
  for (const m of text.matchAll(/<vc:([\w-]+)/g)) out.components.push({ name: kebabToPascal(m[1]), line: at(m.index) });
  for (const m of text.matchAll(/<(?:a|form)\b([^>]*\basp-(?:action|controller)\b[^>]*)>/g)) {
    const attrs = tagAttrs(m[1]);
    out.links.push({ action: attrs['asp-action'] ?? 'Index', controller: attrs['asp-controller'] ?? null, area: attrs['asp-area'] ?? null, line: at(m.index), via: 'asp-action' });
  }

  for (const m of text.matchAll(/^\s*@section\s+(\w+)\s*\{?/gm)) {
    // Its extent, so what's inside it is known to render where the layout renders the section.
    const open = text.indexOf('{', m.index + m[0].indexOf('@'));
    const end = open === -1 ? m.index : matchBrace(text, open);
    out.sections.push({ name: m[1], line: at(m.index + m[0].indexOf('@')), end: at(end) });
  }
  for (const m of text.matchAll(/\bRenderSection(?:Async)?\s*\(\s*"(\w+)"\s*(?:,\s*(?:required\s*:\s*)?(true|false))?/g)) {
    out.renderSections.push({ name: m[1], required: m[2] !== 'false', line: at(m.index) });
  }
  const body = /\bRenderBody\s*\(\s*\)/.exec(text);
  if (body) out.renderBody = at(body.index);

  // Bundles: Scripts.Render("~/bundles/a", "~/bundles/b"), Styles.Render(…), and their Url forms.
  for (const m of text.matchAll(/\b(Scripts|Styles)\.(?:Render|RenderFormat|Url)\s*\(/g)) {
    const { args } = callArgs(text, m.index + m[0].length - 1);
    const list = /RenderFormat/.test(m[0]) ? args.slice(1) : args;
    for (const a of list) if (a.literal) out.bundles.push({ path: a.literal, kind: m[1] === 'Scripts' ? 'script' : 'style', line: at(m.index) });
  }

  // Accessibility, read from the markup alone: what a screen reader or a keyboard can't use.
  const inputs = [];
  const labelFor = new Set();
  const labelAspFor = new Set();
  const dynamic = (v) => v != null && /@/.test(v);
  function a11yTag(name, get, attrs, text, end, line) {
    const has = (n) => attrs.some((a) => a.name === n);
    const named = has('aria-label') || has('aria-labelledby') || has('title');
    if (name === 'html' && !has('lang')) out.a11y.push({ rule: 'html-lang', line, what: '<html> without lang' });
    if (name === 'img' && !has('alt') && !has('role')) out.a11y.push({ rule: 'img-alt', line, what: `<img src="${(get('src')?.value ?? '').slice(0, 60)}"> without alt` });
    if (name === 'label') {
      if (get('for')?.value) labelFor.add(get('for').value);
      if (get('asp-for')?.value) labelAspFor.add(get('asp-for').value);
    }
    if ((name === 'input' || name === 'select' || name === 'textarea') && !named) {
      const type = (get('type')?.value ?? 'text').toLowerCase();
      if (!['hidden', 'submit', 'button', 'reset', 'image'].includes(type)) {
        // Wrapped in a <label> on the same or the line before: labelled.
        const before = text.slice(Math.max(0, text.lastIndexOf('<', Math.max(0, text.lastIndexOf('\n', end - 1) - 1)) - 200), end);
        if (!/<label\b(?![^>]*\bfor=)[^>]*>(?![\s\S]*<\/label>)/i.test(before)) inputs.push({ id: dynamic(get('id')?.value) ? null : get('id')?.value, aspFor: get('asp-for')?.value, line, what: `<${name}${get('name')?.value ? ` name="${get('name').value}"` : get('id')?.value ? ` id="${get('id').value}"` : ''}>` });
      }
    }
    if ((name === 'button' || name === 'a') && !named) {
      const close = text.indexOf(`</${name}`, end);
      const inner = close === -1 || close - end > 2000 ? null : text.slice(end + 1, close);
      if (inner != null && !/@/.test(inner) && !/<img\b[^>]*\balt="[^"]+"/i.test(inner) && !inner.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, '').trim() && (name === 'button' || has('href'))) {
        out.a11y.push({ rule: name === 'button' ? 'empty-button' : 'empty-link', line, what: `<${name}> with no text or label` });
      }
    }
    if ((name === 'div' || name === 'span' || name === 'li' || name === 'td' || name === 'i') && has('onclick') && !has('role') && !has('tabindex')) out.a11y.push({ rule: 'click-no-keyboard', line, what: `<${name} onclick> without role and tabindex` });
    const tabindex = get('tabindex')?.value;
    if (tabindex && /^[1-9]\d*$/.test(tabindex)) out.a11y.push({ rule: 'tabindex-positive', line, what: `tabindex="${tabindex}"` });
  }

  // Elements: scripts, styles, classes, ids, data- attributes, event handlers.
  const tagRe = /<([a-zA-Z][\w:-]*)\b/g;
  let t;
  while ((t = tagRe.exec(text))) {
    const name = t[1].toLowerCase();
    // The tag's attributes, read with attrValue so Razor quotes inside a value don't end it.
    let i = t.index + t[0].length;
    const attrs = [];
    while (i < text.length) {
      while (/\s/.test(text[i] ?? '')) i++;
      if (text[i] === '>' || (text[i] === '/' && text[i + 1] === '>') || i >= text.length) break;
      if (text[i] === '@') {
        // A Razor expression among the attributes (@Html.Raw(…), @attributes): skip it.
        const m = /^@(?:\((?:[^()]|\([^()]*\))*\)|[\w.]+(?:\((?:[^()]|\([^()]*\))*\))?)/.exec(text.slice(i, i + 400));
        i += m ? m[0].length : 1;
        continue;
      }
      const an = /^[^\s=>/]+/.exec(text.slice(i, i + 200));
      if (!an) {
        i++;
        continue;
      }
      const attrName = an[0];
      const attrAt = i;
      i += attrName.length;
      while (text[i] === ' ' || text[i] === '\t') i++;
      if (text[i] === '=') {
        i++;
        while (text[i] === ' ' || text[i] === '\t') i++;
        const { value, end } = attrValue(text, i);
        attrs.push({ name: attrName.toLowerCase(), value, at: attrAt });
        i = end;
      } else attrs.push({ name: attrName.toLowerCase(), value: null, at: attrAt });
      if (attrs.length > 80) break;
    }
    const get = (n) => attrs.find((a) => a.name === n);
    // Requests the markup itself makes: unobtrusive Ajax (data-ajax="true"), htmx, and data-url-style
    // attributes a script reads.
    const ajaxAttr = attrs.find((a) => /^(?:data-ajax-url|data-url|data-src|data-load-url|data-href|data-source|data-action-url|data-remote|hx-(?:get|post|put|delete|patch))$/.test(a.name) && a.value);
    const unobtrusive = get('data-ajax')?.value === 'true' ? get('href') ?? get('action') : null;
    for (const a of [ajaxAttr, unobtrusive].filter(Boolean)) {
      const where = urlOf(a.value.startsWith('@') ? a.value : JSON.stringify(a.value));
      if (!where || where.dynamic) continue;
      const target = get('data-ajax-update')?.value ?? get('hx-target')?.value ?? null;
      const method = /^hx-(\w+)$/.exec(a.name)?.[1]?.toUpperCase() ?? get('data-ajax-method')?.value?.toUpperCase() ?? (name === 'form' ? (get('method')?.value ?? 'POST').toUpperCase() : 'GET');
      out.calls.push({ ...where, method, via: a.name, line: at(a.at), ...(target ? { target } : {}) });
    }
    for (const a of attrs) {
      const line = at(a.at);
      if (a.name === 'class' && a.value != null) for (const c of classTokens(a.value)) out.classes.push([c, line]);
      else if (a.name === 'id' && a.value != null && isToken(a.value)) out.ids.push([a.value, line]);
      else if (a.name.startsWith('data-')) out.attrs.push([a.name, line]);
      else if (/^on[a-z]+$/.test(a.name) && a.value) {
        for (const f of a.value.matchAll(/(?:^|[^.\w$])([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/g)) {
          if (!/^(if|return|function|new|typeof)$/.test(f[1])) out.handlers.push({ fn: f[1], event: a.name, line });
        }
      }
    }
    const line = at(t.index);
    const style = get('style');
    if (style?.value) {
      out.inlineStyles.push([line, style.value.trim().slice(0, 120)]);
      for (const u of style.value.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) if (!/^(data:|https?:|\/\/)/i.test(u[1])) out.images.push([staticUrl(u[1]) ?? u[1], line]);
    }
    if (name === 'img' || (name === 'source' && get('srcset')) || (name === 'link' && /icon/i.test(get('rel')?.value ?? ''))) {
      const src = staticUrl(get('src')?.value ?? get('href')?.value ?? (get('srcset')?.value ?? '').split(/[\s,]/)[0] ?? '');
      if (src && !/^(data:|https?:|\/\/)/i.test(src)) out.images.push([src, line]);
    }
    // Text people read, written into the markup rather than through a resource.
    for (const a of attrs) {
      if (['placeholder', 'title', 'alt', 'aria-label'].includes(a.name) && a.value && !a.value.includes('@') && /\p{L}{2,}/u.test(a.value)) out.texts.push([a.value.trim().slice(0, 80), at(a.at), a.name]);
    }
    a11yTag(name, get, attrs, text, i, line);
    if (name === 'script') {
      const src = get('src');
      const include = get('asp-src-include');
      if (src?.value) {
        const url = staticUrl(src.value);
        if (url) out.scripts.push({ src: url, line });
        else out.dynamic.push({ what: `<script src="${src.value}">`, line });
      }
      if (include?.value) out.scripts.push({ src: include.value, line, glob: true });
      if (!src && !include) {
        const close = text.indexOf('</script>', i);
        const type = get('type')?.value ?? '';
        if (close !== -1 && !/template|html|json|x-tmpl|text\/x-/i.test(type)) {
          const body = text.slice(i + 1, close);
          // Script parsers on the block alone, its lines moved to where the block sits in the view.
          out.inline.script = mergeInline(out.inline.script, parseScript(body), line - 1 + countNewlines(text, t.index, i + 1));
        }
      }
    } else if (name === 'link') {
      const href = get('href');
      const rel = get('rel')?.value ?? '';
      if (href?.value && (/stylesheet/i.test(rel) || /\.(css|less)(\?|$)/i.test(href.value))) {
        const url = staticUrl(href.value);
        if (url) out.styles.push({ href: url, line });
        else out.dynamic.push({ what: `<link href="${href.value}">`, line });
      }
      const include = get('asp-href-include');
      if (include?.value) out.styles.push({ href: include.value, line, glob: true });
    } else if (name === 'style') {
      const close = text.indexOf('</style>', i);
      if (close !== -1) out.inline.style = mergeInline(out.inline.style, parseStyle(text.slice(i + 1, close), 'css'), line - 1 + countNewlines(text, t.index, i + 1));
    }
  }
  // Html helpers' htmlAttributes: new { @class = "btn btn-primary", id = "save" }
  for (const m of text.matchAll(/@class\s*=\s*"([^"]*)"/g)) for (const c of classTokens(m[1])) out.classes.push([c, at(m.index)]);
  for (const m of text.matchAll(/new\s*\{[^}]*?\bid\s*=\s*"([\w-]+)"/g)) out.ids.push([m[1], at(m.index)]);
  for (const m of text.matchAll(/\bdata_([\w_]+)\s*=/g)) out.attrs.push([`data-${m[1].replace(/_/g, '-').toLowerCase()}`, at(m.index)]);

  // Inputs whose label couldn't be found in the view: a <label for>, an asp-for label, or ARIA.
  for (const input of inputs) {
    if (input.id && labelFor.has(input.id)) continue;
    if (input.aspFor && labelAspFor.has(input.aspFor)) continue;
    out.a11y.push({ rule: 'input-label', line: input.line, what: input.what });
  }
  const seenIds = new Map();
  for (const [id, line] of out.ids) {
    if (seenIds.has(id) && seenIds.get(id) !== line) out.a11y.push({ rule: 'duplicate-id', line, what: `#${id} (also line ${seenIds.get(id)})` });
    else seenIds.set(id, line);
  }
  out.widgets = findWidgets(text, { markup: true, scripts: false });
  out.calls.sort((a, b) => a.line - b.line);

  // The view model's properties the view reads: Model.X, m => m.X in helpers, asp-for="X".
  for (const m of text.matchAll(/\bModel\??\.(\w+)/g)) out.modelUses.push([m[1], at(m.index)]);
  for (const m of text.matchAll(/\(\s*(\w+)\s*=>\s*\1\??\.(\w+)/g)) out.modelUses.push([m[2], at(m.index)]);
  for (const m of text.matchAll(/\basp-for\s*=\s*"(?:@?Model\.)?(\w+)/g)) out.modelUses.push([m[1], at(m.index)]);
  // Text between tags, outside scripts, styles and code: what a translation would have to cover.
  const skip = [...text.matchAll(/<(script|style)\b[\s\S]*?<\/\1>/g)].map((m) => [m.index, m.index + m[0].length]);
  for (const m of text.matchAll(/>([^<>]+)</g)) {
    // `=>` is a lambda (m => m.Phone), not the end of a tag.
    if (text[m.index - 1] === '=' || skip.some(([a, b]) => m.index > a && m.index < b)) continue;
    const plain = m[1].replace(/@await\s+/g, '@').replace(/@\((?:[^()]|\([^()]*\))*\)|@[\w.]+(?:\?\.[\w.]+)*(?:\([^)]*\)|\[[^\]]*\])?|&[#\w]+;/g, ' ').trim();
    if (!/\p{L}{2,}/u.test(plain) || /[{};=]|^\s*(if|else|foreach|for|var|using|return)\b/.test(plain)) continue;
    out.texts.push([plain.replace(/\s+/g, ' ').slice(0, 80), at(m.index + 1), 'text']);
  }
  out.localized = (text.match(/\b(?:Localizer|ViewLocalizer|SharedLocalizer|L)\[|\bResources?\.\w+\.\w+|@Html\.Resource\b|@T\(|\bStrings\.\w+|GetLocalizedString\(|\bResx\.\w+/g) ?? []).length;
  // A link that is also a call (data-url="@Url.Action(…)", an Ajax.ActionLink's href) is listed once, as the call.
  const same = (l, c) => l.line === c.line && (l.url && c.url ? l.url.toLowerCase() === c.url.toLowerCase() : l.action && c.action && l.action.toLowerCase() === c.action.toLowerCase());

  // Links written out: href="/Orders/Edit" (not assets, not external).
  for (const m of text.matchAll(/\b(?:href|action)\s*=\s*"(~?\/[A-Za-z][\w-]*(?:\/[\w-]*)*)\/?(?:[?#][^"]*)?"/g)) {
    out.links.push({ url: m[1].replace(/^~/, ''), line: at(m.index), via: 'href' });
  }
  out.links = out.links.filter((l) => !out.calls.some((c) => same(l, c)));
  return out;
}

const countNewlines = (text, from, to) => {
  let n = 0;
  for (let i = text.indexOf('\n', from); i !== -1 && i < to; i = text.indexOf('\n', i + 1)) n++;
  return n;
};

/** A parse of an inline block with its lines moved down by `offset`, merged into `into`. */
function mergeInline(into, parsed, offset) {
  const shift = (v) => {
    if (Array.isArray(v)) return v.map(shift);
    if (typeof v === 'number') return v;
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, x] of Object.entries(v)) o[k] = k === 'line' && typeof x === 'number' ? x + offset : shift(x);
      return o;
    }
    return v;
  };
  // [name, line] pairs: the line is the second element.
  const pairs = (list) => list.map(([n, l]) => [n, l + offset]);
  const moved = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (Array.isArray(v) && Array.isArray(v[0])) moved[k] = pairs(v);
    else moved[k] = shift(v);
  }
  if (!into) return moved;
  for (const [k, v] of Object.entries(moved)) if (Array.isArray(v)) into[k] = [...(into[k] ?? []), ...v];
  return into;
}
