// One build against another: what each run weighed (a summary small enough to keep for every commit),
// the change per chunk and per package, the sentence that says why ("+42.1 kB gzip, from date-fns 4
// now imported whole"), and the Markdown table for a pull request. Pure.
import { packageTotals, totals } from './build.js';
import { formatBytes, formatDelta, formatPercent } from './sizes.js';
import { majorOf } from './packages.js';

/**
 * What is kept of a build: { key, commit, branch, dirty, at, tool, source, total, chunks: [{ name, file,
 * raw, gzip, brotli }], packages: [{ name, raw, gzip, brotli, modules, versions }] }. `key` is the
 * commit, with `+dirty` for a build of a working tree with changes in it.
 */
export function summarize(build, { commit = null, branch = null, dirty = false, at = Date.now() } = {}) {
  const gz = new Map(packageTotals(build.chunks, 'gzip').map((p) => [p.name, p]));
  const br = new Map(packageTotals(build.chunks, 'brotli').map((p) => [p.name, p.size]));
  return {
    key: commit ? `${commit}${dirty ? '+dirty' : ''}` : `uncommitted-${at}`,
    commit,
    branch,
    dirty: Boolean(dirty),
    at,
    tool: build.tool ?? null,
    source: build.source?.label ?? null,
    total: totals(build.chunks),
    chunks: build.chunks.map((c) => ({ name: c.name, file: c.file, raw: c.raw, gzip: c.gzip, brotli: c.brotli })),
    packages: [...gz.values()].map((p) => ({ name: p.name, raw: p.bytes, gzip: p.size, brotli: br.get(p.name) ?? null, modules: p.modules, versions: p.versions })),
  };
}

/** The measure both runs have: `measure` when both were compressed, else raw. */
export const commonMeasure = (base, head, measure = 'gzip') => (measure !== 'raw' && base?.total?.[measure] != null && head?.total?.[measure] != null ? measure : 'raw');

const sizeOf = (x, m) => (x ? (x[m] ?? x.raw ?? 0) : 0);

/** Why a package's size changed, in a few words: "date-fns 4 now imported whole". */
export function packageReason(p) {
  const name = p.name;
  if (!p.before) return `${name}${p.after?.versions?.length === 1 ? ` ${majorOf(p.after.versions[0])}` : ''} newly bundled`;
  if (!p.after) return `${name} no longer bundled`;
  const was = p.before.versions ?? [];
  const now = p.after.versions ?? [];
  const moved = was.join() !== now.join() && now.length > 0;
  // The version that came in (date-fns 4 beside the 2 a dependency still brings), when it is one.
  const added = now.filter((v) => !was.includes(v));
  const newMajor = added.length === 1 ? ` ${majorOf(added[0])}` : moved && now.length === 1 ? ` ${majorOf(now[0])}` : '';
  if (p.after.modules >= 10 && p.after.modules >= 3 * p.before.modules) return `${name}${newMajor} now imported whole`;
  if (p.before.modules >= 10 && p.before.modules >= 3 * p.after.modules) return `${name} no longer imported whole`;
  if (moved) return `${name} ${was.join('/') || '?'} → ${now.join('/')}`;
  return `${name} ${p.delta > 0 ? 'grew' : 'shrank'} by ${formatBytes(Math.abs(p.delta))}`;
}

/**
 * `head` against `base` (two summaries): { measure, total: { before, after, delta }, chunks, packages,
 * headline, reason }. Chunks and packages are those that changed, biggest change first, each with
 * `before`, `after` (null when it wasn't there), `delta` and `status` (added, removed, changed, same).
 */
export function compareRuns(base, head, measure = 'gzip') {
  const m = commonMeasure(base, head, measure);
  const pair = (a = [], b = [], key) => {
    const names = [...new Set([...a.map(key), ...b.map(key)])];
    const ma = new Map(a.map((x) => [key(x), x]));
    const mb = new Map(b.map((x) => [key(x), x]));
    return names.map((n) => {
      const before = ma.get(n) ?? null;
      const after = mb.get(n) ?? null;
      const delta = sizeOf(after, m) - sizeOf(before, m);
      const status = !before ? 'added' : !after ? 'removed' : delta ? 'changed' : 'same';
      return { name: n, before, after, delta, status };
    });
  };
  const chunks = pair(base.chunks, head.chunks, (c) => c.name).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.name.localeCompare(b.name));
  const packages = pair(base.packages, head.packages, (p) => p.name)
    .filter((p) => p.status !== 'same')
    .map((p) => ({ ...p, reason: '' }))
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.name.localeCompare(b.name));
  for (const p of packages) p.reason = packageReason(p);
  const before = sizeOf(base.total, m);
  const after = sizeOf(head.total, m);
  const delta = after - before;
  // The package that explains it: the biggest change the same way as the whole, if it is a good part of it.
  const top = packages.find((p) => Math.sign(p.delta) === Math.sign(delta) && Math.abs(p.delta) >= Math.abs(delta) * 0.25);
  const reason = delta && top ? top.reason : '';
  const headline = delta ? `${formatDelta(delta)} ${m}${reason ? `, from ${reason}` : ''}` : `No change in ${m} size`;
  return { measure: m, total: { before, after, delta, percent: before ? (delta / before) * 100 : null }, chunks, packages, headline, reason };
}

/** "main (a1b2c3d, 2026-11-01)" or "the last build (…)", for what a comparison is against. */
export function runLabel(run, name = null) {
  const bits = [run.commit ? run.commit.slice(0, 7) + (run.dirty ? '+dirty' : '') : null, run.at ? new Date(run.at).toISOString().slice(0, 10) : null].filter(Boolean);
  return `${name ?? (run.branch ? run.branch : 'a build')}${bits.length ? ` (${bits.join(', ')})` : ''}`;
}

const cell = (s) => String(s).replace(/\|/g, '\\|');

/**
 * The comparison as Markdown, for a pull request: the headline with the percentage, what it's against,
 * the chunks that changed and the total, then the packages that changed in a fold.
 */
export function compareMarkdown(result, { base, head, baseName = null, title = 'Bundle size' }) {
  const { measure: m, total } = result;
  const pct = formatPercent(total.delta, total.before);
  const lines = [`### ${title}: ${total.delta ? `${formatDelta(total.delta)} ${m}${pct ? ` (${pct})` : ''}` : `no change in ${m}`}`, ''];
  lines.push(`Against ${runLabel(base, baseName ? `\`${baseName}\`` : null)}${head.commit ? `, this build at \`${head.commit.slice(0, 7)}${head.dirty ? '+dirty' : ''}\`` : ''}${result.reason ? `: from ${result.reason}.` : '.'}`, '');
  const changed = result.chunks.filter((c) => c.status !== 'same');
  const same = result.chunks.length - changed.length;
  lines.push('| Chunk | Before | After | Change |', '| --- | ---: | ---: | ---: |');
  const size = (x) => (x ? formatBytes(x[m] ?? x.raw) : '—');
  for (const c of changed) {
    const change = c.status === 'added' ? 'new' : c.status === 'removed' ? 'removed' : `${formatDelta(c.delta)}${formatPercent(c.delta, c.before?.[m] ?? c.before?.raw) ? ` (${formatPercent(c.delta, c.before?.[m] ?? c.before?.raw)})` : ''}`;
    lines.push(`| \`${cell(c.name)}\` | ${size(c.before)} | ${size(c.after)} | ${Math.abs(c.delta) >= 1000 ? `**${change}**` : change} |`);
  }
  lines.push(`| **Total** | ${formatBytes(total.before)} | ${formatBytes(total.after)} | **${formatDelta(total.delta)}${pct ? ` (${pct})` : ''}** |`);
  if (same) lines.push('', `${same} chunk${same === 1 ? '' : 's'} unchanged.`);
  if (result.packages.length) {
    lines.push('', `<details><summary>Packages that changed (${result.packages.length})</summary>`, '', '| Package | Before | After | Change | Why |', '| --- | ---: | ---: | ---: | --- |');
    for (const p of result.packages.slice(0, 30)) {
      const versions = [p.before?.versions?.join('/'), p.after?.versions?.join('/')].filter(Boolean);
      const v = versions.length === 2 && versions[0] !== versions[1] ? ` ${versions[0]} → ${versions[1]}` : versions.length ? ` ${versions.at(-1)}` : '';
      lines.push(`| \`${cell(p.name)}\`${cell(v)} | ${size(p.before)} | ${size(p.after)} | ${formatDelta(p.delta)} | ${cell(p.reason)} |`);
    }
    if (result.packages.length > 30) lines.push('', `And ${result.packages.length - 30} more.`);
    lines.push('', '</details>');
  }
  lines.push('', `Sizes ${m === 'raw' ? 'as built' : `after ${m}`}; a package's is its share of the chunks it is in. Measured by Ballast.`);
  return `${lines.join('\n')}\n`;
}
