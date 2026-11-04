// A .cshtml file read for what it pulls in and what it marks up: its model and layout, the partials,
// child actions, view components and templates it renders, the sections it defines and renders, the
// scripts, styles and bundles it loads, the CSS classes, ids and data- attributes on its elements,
// the JavaScript its event attributes call, and the controllers and actions it links or posts to.
// Inline <script> and <style> blocks are read by the script and style parsers, with their lines kept.
// Regular expressions over the text, not a Razor compiler: a dynamic name (`Html.Partial(name)`)
// isn't followed, and the index reports it as such.
import { isToken, lineIndex, literals, matchBrace, stripRazorComments } from '../text.js';
import { parseScript } from './script.js';
import { parseStyle } from './style.js';

/** The top-level arguments of a call whose `(` is at `open`: [{ text, literal }], and the offset after `)`. */
export function callArgs(text, open) {
  const args = [];
  let depth = 0;
  let start = open + 1;
  let i = open;
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const q = c;
      i++;
      while (i < text.length && text[i] !== q && text[i] !== '\n') {
        if (text[i] === '\\') i++;
        i++;
      }
    } else if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') {
      depth--;
      if (depth === 0) {
        args.push(text.slice(start, i));
        break;
      }
    } else if (c === ',' && depth === 1) {
      args.push(text.slice(start, i));
      start = i + 1;
    }
    if (i - open > 2000) break;
  }
  return {
    args: args
      .map((a) => a.trim())
      .filter((a, n) => a || n > 0)
      .map((a) => {
        const m = /^(?:\w+\s*:\s*)?(?:@?"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')$/.exec(a);
        return { text: a, literal: m ? (m[1] ?? m[2]) : null, named: /^(\w+)\s*:/.exec(a)?.[1] ?? null };
      }),
    end: i + 1,
  };
}

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
      const values = routeValues(args.map((a) => a.text).join(','));
      const action = lit(first);
      if (action) out.links.push({ action, controller: lit(first + 1) ?? values.controller ?? null, area: values.area ?? null, line, via });
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

  // Links written out: href="/Orders/Edit" (not assets, not external).
  for (const m of text.matchAll(/\b(?:href|action)\s*=\s*"(~?\/[A-Za-z][\w-]*(?:\/[\w-]*)*)\/?(?:[?#][^"]*)?"/g)) {
    out.links.push({ url: m[1].replace(/^~/, ''), line: at(m.index), via: 'href' });
  }
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
