// `pilot diagram`: a page, a node's neighbourhood or the path between two things as Mermaid (for a
// pull request or a wiki: GitHub and Azure DevOps draw it) or Graphviz DOT.
import { posix } from 'node:path';
import { graph, nodeInfo, nodeType, pageModel, path } from './analysis.js';
import { resolveTarget, urlOf } from './queries.js';

const COLORS = { view: '#3b82f6', partial: '#0ea5b7', layout: '#8b5cf6', action: '#f59f00', script: '#c9a227', style: '#e64980', bundle: '#868e96', cs: '#2f9e44', config: '#748094', missing: '#e03131' };

/** Draws nodes ({ id, label, type }) and edges ({ from, to, label?, dashed? }) as Mermaid or DOT. */
export function draw({ nodes, edges, direction = 'LR', format = 'mermaid', title = null }) {
  const ids = new Map(nodes.map((n, i) => [n.id, `n${i}`]));
  const label = (s) => String(s).replace(/"/g, "'").replace(/[<>]/g, '');
  if (format === 'dot') {
    const lines = [`digraph pilot {`, `  rankdir=${direction};`, '  node [shape=box, style="rounded,filled", fontname="Helvetica", fontsize=11, fillcolor="#ffffff"];', '  edge [fontname="Helvetica", fontsize=9, color="#888888"];'];
    if (title) lines.push(`  label="${label(title)}"; labelloc=t;`);
    for (const n of nodes) lines.push(`  ${ids.get(n.id)} [label="${label(n.label)}", color="${COLORS[n.type] ?? '#748094'}", penwidth=2];`);
    for (const e of edges) if (ids.has(e.from) && ids.has(e.to)) lines.push(`  ${ids.get(e.from)} -> ${ids.get(e.to)}${e.label || e.dashed ? ` [${[e.label ? `label="${label(e.label)}"` : '', e.dashed ? 'style=dashed' : ''].filter(Boolean).join(', ')}]` : ''};`);
    lines.push('}');
    return lines.join('\n');
  }
  const lines = [...(title ? ['---', `title: ${label(title)}`, '---'] : []), `flowchart ${direction}`];
  for (const n of nodes) lines.push(`  ${ids.get(n.id)}["${label(n.label)}"]:::${COLORS[n.type] ? n.type : 'config'}`);
  for (const e of edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) continue;
    const arrow = e.dashed ? '-.->' : '-->';
    lines.push(`  ${ids.get(e.from)} ${arrow}${e.label ? `|"${label(e.label)}"|` : ''} ${ids.get(e.to)}`);
  }
  const used = new Set(nodes.map((n) => (COLORS[n.type] ? n.type : 'config')));
  for (const [type, color] of Object.entries(COLORS)) if (used.has(type)) lines.push(`  classDef ${type} stroke:${color},stroke-width:2px`);
  return lines.join('\n');
}

const short = (id, idx) => {
  const info = nodeInfo(idx, id);
  return info.type === 'action' ? `${info.label}${info.sub ? `<br/>${info.sub}` : ''}`.replace('<br/>', ' ') : posix.basename(id);
};

/** A page: its layouts, views and partials as rendered, its scripts, and their requests and what answers them. */
function pageDiagram(idx, view) {
  const m = pageModel(idx, view);
  const nodes = new Map();
  const edges = [];
  const add = (id, type) => {
    if (!nodes.has(id)) nodes.set(id, { id, type: type ?? nodeType(idx, id), label: short(id, idx) });
  };
  const walk = (node, parent) => {
    for (const c of node.children) {
      if (c.type === 'body' || c.type === 'section') {
        add(c.file);
        edges.push({ from: parent, to: c.file, label: c.type === 'body' ? 'body' : c.name });
        walk(c, c.file);
      } else if (c.type === 'child-action') {
        add(c.action, 'action');
        edges.push({ from: parent, to: c.action, label: 'child action' });
        for (const v of c.children) {
          add(v.file);
          edges.push({ from: c.action, to: v.file });
          walk(v, v.file);
        }
      } else {
        add(c.file);
        edges.push({ from: parent, to: c.file, label: c.type === 'partial' ? null : c.type });
        if (!c.again) walk(c, c.file);
      }
    }
  };
  add(m.tree.root.file);
  walk(m.tree.root, m.tree.root.file);
  for (const s of m.scripts.filter((x) => x.own && !x.vendor && !x.imported)) {
    add(s.file, 'script');
    edges.push({ from: view, to: s.file, label: 'script', dashed: true });
  }
  for (const c of m.calls.filter((x) => x.own)) {
    add(c.from);
    add(c.action, 'action');
    edges.push({ from: c.from, to: c.action, label: `${c.method ?? ''} ${c.request}`.trim(), dashed: true });
    for (const r of c.returns) {
      add(r.file);
      edges.push({ from: c.action, to: r.file, label: c.target ? `into ${c.target}` : 'returns' });
    }
  }
  return { nodes: [...nodes.values()], edges, direction: 'TD' };
}

/**
 * `target` drawn as `kind`: 'page' (the default for a view, URL or action), 'graph' (a node's
 * neighbourhood, `depth` steps each way) or 'path' (from `target` to `to`).
 */
export function diagram(idx, target, { kind = null, to = null, depth = 1, format = 'mermaid' } = {}) {
  let spec;
  let title;
  if (to) {
    const p = path(idx, target, to);
    if (!p.data.steps?.length) return { data: { error: 'no path' }, text: p.text };
    const ids = [p.data.from, ...p.data.steps.map((s) => s.to)];
    spec = {
      nodes: ids.map((id) => ({ id, type: nodeType(idx, id), label: short(id, idx) })),
      edges: p.data.steps.map((s) => (s.direction === 'out' ? { from: s.from, to: s.to, label: `${s.kind}${s.method ? ` ${s.method}` : ''}` } : { from: s.to, to: s.from, label: s.kind })),
      direction: 'LR',
    };
    title = `${posix.basename(target)} to ${posix.basename(to)}`;
  } else {
    const r = resolveTarget(idx, target);
    const view = r.files.find((f) => idx.files.get(f)?.kind === 'view') ?? (r.actions[0] && idx.out(r.actions[0]).find((e) => e.kind.startsWith('renders'))?.to);
    // A page for a URL, an action or a view an action returns; a partial is drawn with what's around it.
    const isPage = view && (r.actions.length || !idx.isPartial(view));
    if ((kind ?? (isPage ? 'page' : 'graph')) === 'page' && view) {
      spec = pageDiagram(idx, view);
      title = r.actions[0] ? urlOf(idx, r.actions[0]) : view;
    } else {
      const g = graph(idx, target, { depth, kinds: ['layout', 'partial', 'template', 'component', 'child-action', 'renders', 'renders-partial', 'script', 'style', 'import', 'source', 'calls'] });
      if (g.data.error) return { data: g.data, text: g.text };
      spec = { nodes: g.data.nodes.map((n) => ({ id: n.id, type: n.type, label: short(n.id, idx) })), edges: g.data.edges.map((e) => ({ from: e.from, to: e.to, label: e.kind === 'partial' ? null : e.kind, dashed: e.kind === 'calls' })), direction: 'LR' };
      title = g.data.focus;
    }
  }
  const text = draw({ ...spec, format, title });
  return { data: { format, nodes: spec.nodes.length, edges: spec.edges.length, diagram: text }, text: format === 'dot' ? text : `\`\`\`mermaid\n${text}\n\`\`\`` };
}
