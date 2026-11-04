// A .cs file read for what decides which view a request gets: controllers and their actions (the
// views each returns, its HTTP verbs and attribute routes), view components, System.Web.Optimization
// bundles (BundleConfig) and conventional routes (MapRoute, MapControllerRoute). Regular expressions
// and a brace matcher, not Roslyn.
import { callArgs, lineIndex, matchBrace, stripComments } from '../text.js';

/** The attributes ([HttpPost], [Route("x")]) written just before `offset`. */
function attributesBefore(text, offset) {
  const before = text.slice(Math.max(0, offset - 800), offset);
  const block = /((?:\s*\[[^\]]*(?:\([^)]*\))?[^\]]*\])*)\s*$/.exec(before)?.[1] ?? '';
  const out = [];
  for (const m of block.matchAll(/\[([^\]]+)\]/g)) for (const part of m[1].split(/,(?![^(]*\))/)) out.push(part.trim());
  return out;
}

const attrArg = (attrs, name) => {
  for (const a of attrs) {
    const m = new RegExp(`^${name}(?:Attribute)?\\s*\\(\\s*(?:\\w+\\s*=\\s*)?"([^"]*)"`).exec(a);
    if (m) return m[1];
  }
  return null;
};

const VERBS = ['HttpGet', 'HttpPost', 'HttpPut', 'HttpDelete', 'HttpPatch'];

export function parseCSharp(source) {
  const text = stripComments(source);
  const lineOf = lineIndex(text);
  const out = { controllers: [], components: [], bundles: [], routes: [], models: [] };

  for (const m of text.matchAll(/\bclass\s+(\w+?)(Controller|ViewComponent)\b\s*(?:<[^>]*>)?\s*(?::\s*([^{]+))?\{/g)) {
    const [, name, suffix, bases = ''] = m;
    const open = m.index + m[0].length - 1;
    const close = matchBrace(text, open);
    const body = text.slice(open, close);
    const attrs = attributesBefore(text, m.index - (/(?:public|internal|sealed|abstract|partial|static|\s)*$/.exec(text.slice(Math.max(0, m.index - 80), m.index))?.[0].length ?? 0));
    const abstract = /\babstract\s+(?:partial\s+)?$/.test(text.slice(Math.max(0, m.index - 40), m.index));
    if (suffix === 'ViewComponent') {
      const views = [];
      for (const v of body.matchAll(/\bView\s*(?:<[^>]*>)?\s*\(/g)) {
        const { args } = callArgs(body, v.index + v[0].length - 1);
        views.push({ name: args[0]?.literal ?? 'Default', line: lineOf(open + v.index) });
      }
      out.components.push({ name: attrArg(attrs, 'ViewComponent') ?? name, className: name + suffix, line: lineOf(m.index), views });
      continue;
    }
    const controller = {
      name,
      className: name + suffix,
      line: lineOf(m.index),
      base: bases.split(',')[0].trim() || null,
      area: attrArg(attrs, 'Area') ?? attrArg(attrs, 'RouteArea'),
      route: attrArg(attrs, 'Route') ?? attrArg(attrs, 'RoutePrefix'),
      api: attrs.some((a) => /^ApiController\b/.test(a)) || /\bApiController\b/.test(bases),
      abstract,
      actions: [],
    };
    // Public methods inside the class, each with the views and redirects in its body.
    const methodRe = /\bpublic\s+((?:(?:virtual|override|async|static|new|sealed)\s+)*)([\w<>[\]?,.\s]+?)\s+(\w+)\s*(?:<[^>]*>)?\s*\(/g;
    let mm;
    while ((mm = methodRe.exec(body))) {
      const returns = mm[2].trim();
      if (/\bclass\b|\bstatic\b/.test(mm[1]) || mm[3] === name + suffix) continue;
      if (!/Result|string|void|Task|object|IHttpActionResult|Json/i.test(returns)) continue;
      const { end } = callArgs(body, mm.index + mm[0].length - 1);
      const brace = body.indexOf('{', end);
      const arrow = body.indexOf('=>', end);
      const semi = body.indexOf(';', end);
      let methodBody;
      let stop;
      let bodyAt;
      if (arrow !== -1 && (brace === -1 || arrow < brace) && (semi === -1 || arrow < semi)) {
        stop = body.indexOf(';', arrow);
        methodBody = body.slice(arrow, stop === -1 ? body.length : stop);
        bodyAt = arrow;
      } else if (brace !== -1 && (semi === -1 || brace < semi)) {
        stop = matchBrace(body, brace);
        methodBody = body.slice(brace, stop);
        bodyAt = brace;
      } else continue;
      const mAttrs = attributesBefore(body, mm.index);
      if (mAttrs.some((a) => /^NonAction\b/.test(a))) continue;
      const actionName = attrArg(mAttrs, 'ActionName') ?? mm[3];
      const verbs = VERBS.filter((v) => mAttrs.some((a) => new RegExp(`^${v}\\b`).test(a))).map((v) => v.slice(4).toUpperCase());
      const routes = [attrArg(mAttrs, 'Route'), ...VERBS.map((v) => attrArg(mAttrs, v))].filter((r) => r != null);
      const action = {
        name: actionName,
        method: mm[3],
        line: lineOf(open + mm.index),
        verbs,
        routes,
        childOnly: mAttrs.some((a) => /^ChildActionOnly\b/.test(a)),
        returns,
        views: [],
        redirects: [],
        json: /\bJson\s*\(|\bOk\s*\(/.test(methodBody),
      };
      const at = (i) => lineOf(open + bodyAt + i);
      for (const v of methodBody.matchAll(/\b(View|PartialView)\s*(?:<[^>]*>)?\s*\(/g)) {
        const { args } = callArgs(methodBody, v.index + v[0].length - 1);
        // View() / View(model): the action's name. View("Name") / View("Name", model) / View("~/Views/x.cshtml").
        const first = args[0];
        const name = first?.literal != null && !first.named ? first.literal : null;
        // View(viewName, model): a name decided at run time, which the index can only report.
        const dynamic = first && first.literal == null && /^\w*view\w*$/i.test(first.text) ? first.text : null;
        action.views.push({ name: dynamic ? null : name ?? actionName, dynamic, partial: v[1] === 'PartialView', line: at(v.index) });
      }
      for (const r of methodBody.matchAll(/\bRedirectToAction\s*\(/g)) {
        const { args } = callArgs(methodBody, r.index + r[0].length - 1);
        if (args[0]?.literal) action.redirects.push({ action: args[0].literal, controller: args[1]?.literal ?? null, line: at(r.index) });
      }
      for (const r of methodBody.matchAll(/\bnameof\s*\(\s*(\w+)\s*\)/g)) {
        // RedirectToAction(nameof(Index)): read as a literal name.
        if (/RedirectToAction\s*\(\s*$/.test(methodBody.slice(Math.max(0, r.index - 40), r.index))) action.redirects.push({ action: r[1], controller: null, line: at(r.index) });
      }
      controller.actions.push(action);
      methodRe.lastIndex = stop ?? methodRe.lastIndex;
    }
    out.controllers.push(controller);
  }

  // System.Web.Optimization bundles: new ScriptBundle("~/bundles/x").Include("~/Scripts/a.js", …)
  const bundleRe = /new\s+(Script|Style|)Bundle\s*\(\s*"([^"]+)"/g;
  const starts = [...text.matchAll(bundleRe)];
  starts.forEach((b, n) => {
    const end = n + 1 < starts.length ? starts[n + 1].index : text.length;
    const chunk = text.slice(b.index, Math.min(end, b.index + 6000));
    const kind = b[1] === 'Style' ? 'style' : b[1] === 'Script' ? 'script' : /\.css"/.test(chunk) ? 'style' : 'script';
    const include = [];
    for (const inc of chunk.matchAll(/\.Include(Directory)?\s*\(/g)) {
      const { args } = callArgs(chunk, inc.index + inc[0].length - 1);
      if (inc[1]) {
        if (args[0]?.literal) include.push({ dir: args[0].literal, pattern: args[1]?.literal ?? '*', deep: /true/.test(args[2]?.text ?? '') });
      } else for (const a of args) if (a.literal) include.push({ path: a.literal });
    }
    out.bundles.push({ path: b[2], kind, include, line: lineOf(b.index) });
  });

  // Conventional routes, for their defaults: MapRoute(name, url, defaults) / MapControllerRoute(name, pattern).
  for (const m of text.matchAll(/\b(MapRoute|MapControllerRoute|MapAreaControllerRoute)\s*\(/g)) {
    const { args } = callArgs(text, m.index + m[0].length - 1);
    const template = args.find((a) => a.named === 'url' || a.named === 'pattern')?.literal ?? args.find((a, i) => i > 0 && a.literal && /[{/]/.test(a.literal))?.literal ?? null;
    const defaults = {};
    for (const d of args.map((a) => a.text).join(',').matchAll(/\b(controller|action|area)\s*=\s*"([^"]*)"/gi)) defaults[d[1].toLowerCase()] = d[2];
    for (const d of (template ?? '').matchAll(/\{(controller|action|area)=(\w+)\}/gi)) defaults[d[1].toLowerCase()] = d[2];
    const areaName = m[1] === 'MapAreaControllerRoute' ? args.find((a) => a.named === 'areaName')?.literal ?? args[1]?.literal : null;
    if (areaName) defaults.area = areaName;
    out.routes.push({ template, defaults, line: lineOf(m.index) });
  }
  // Classes with properties (view models, DTOs, entities): what a view's @model can read.
  for (const m of text.matchAll(/\bclass\s+(\w+)\s*(?:<[^>]*>)?\s*(?::\s*([^{]+))?\{/g)) {
    if (/(Controller|ViewComponent)$/.test(m[1])) continue;
    const open = m.index + m[0].length - 1;
    const body = text.slice(open, matchBrace(text, open));
    const props = [];
    for (const p of body.matchAll(/\bpublic\s+(?:(?:virtual|override|required|static|new)\s+)*([\w<>[\]?,.\s]+?)\s+(\w+)\s*\{\s*(?:get|init|set)\b/g)) {
      // Only the class's own properties, not a nested class's.
      const depth = (body.slice(0, p.index).match(/\{/g) ?? []).length - (body.slice(0, p.index).match(/\}/g) ?? []).length;
      if (depth === 1) props.push({ name: p[2], type: p[1].trim(), line: lineOf(open + p.index) });
    }
    if (props.length) out.models.push({ name: m[1], line: lineOf(m.index), base: m[2]?.split(',')[0].trim().replace(/<.*$/, '') || null, props });
  }
  return out;
}
