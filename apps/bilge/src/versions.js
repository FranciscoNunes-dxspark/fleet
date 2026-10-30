// Versions as npm and NuGet write them (1.2.3, 4.0.0.1, 2.0.0-beta.2), compared. Pure.

/** { parts: [numbers], pre: [identifiers] } for a version, build metadata (+…) and a leading v dropped. */
export function parseVersion(v) {
  const s = String(v ?? '').trim().replace(/^v/i, '').split('+')[0];
  const dash = s.indexOf('-');
  const main = dash < 0 ? s : s.slice(0, dash);
  const pre = dash < 0 ? [] : s.slice(dash + 1).split('.');
  return { parts: main.split('.').map((n) => Number.parseInt(n, 10) || 0), pre };
}

/** Negative when `a` is older than `b`, positive when newer, 0 when the same (1.2 and 1.2.0 are). */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < Math.max(x.parts.length, y.parts.length); i++) {
    const d = (x.parts[i] ?? 0) - (y.parts[i] ?? 0);
    if (d) return Math.sign(d);
  }
  // A pre-release comes before its release.
  if (!x.pre.length || !y.pre.length) return Math.sign(y.pre.length - x.pre.length);
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn && Number(p) !== Number(q)) return Math.sign(Number(p) - Number(q));
    if (pn !== qn) return pn ? -1 : 1;
    if (p !== q) return p.toLowerCase() < q.toLowerCase() ? -1 : 1;
  }
  return 0;
}

export const isPrerelease = (v) => parseVersion(v).pre.length > 0;

/** The newest of `versions` (no pre-releases unless they're all there is), or null. */
export function newest(versions) {
  const list = [...versions].filter(Boolean);
  const stable = list.filter((v) => !isPrerelease(v));
  return (stable.length ? stable : list).sort(compareVersions).at(-1) ?? null;
}

/** How far `latest` is ahead of `current`: 'major', 'minor', 'patch', or null when it isn't. */
export function bumpOf(current, latest) {
  if (!latest || compareVersions(latest, current) <= 0) return null;
  const a = parseVersion(current).parts;
  const b = parseVersion(latest).parts;
  if ((b[0] ?? 0) !== (a[0] ?? 0)) return 'major';
  if ((b[1] ?? 0) !== (a[1] ?? 0)) return 'minor';
  return 'patch';
}
