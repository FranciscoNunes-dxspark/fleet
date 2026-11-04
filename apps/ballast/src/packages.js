// Which package a bundled module belongs to, read from its path, and the versions of packages. Pure.
//
// A module's path says it: everything after the last node_modules/ starts with the package's name
// (two parts for a scoped one), and the path up to the end of that name is where it was installed.
// Two installs of one package are two copies in the bundle; the install path also tells npm's nested
// copies apart (node_modules/react-datepicker/node_modules/date-fns). pnpm's store and Yarn's cache
// put the version in the path; npm's layout leaves it to the lock file or the package's package.json.

const NM = 'node_modules/';

/**
 * { name, installPath, version? } for a module path (/-separated, relative to the project or not), or
 * null for the project's own files.
 */
export function packageOf(path) {
  const p = String(path ?? '').replace(/\\/g, '/');
  const last = p.lastIndexOf(NM);
  if (last < 0) return null;
  const parts = p.slice(last + NM.length).split('/');
  if (!parts[0] || parts[0].startsWith('.')) return null;
  const name = parts[0].startsWith('@') ? (parts[1] ? `${parts[0]}/${parts[1]}` : null) : parts[0];
  if (!name) return null;
  // From the first node_modules/ (or Yarn's cache, which comes before it) to the end of the name: the
  // same install reads the same from a stats file made in the project or one folder above it.
  const yarn = p.indexOf('.yarn/');
  const firstNm = p.indexOf(NM);
  const start = yarn >= 0 && yarn < firstNm ? yarn : firstNm;
  const installPath = p.slice(start, last + NM.length + name.length);
  const version = pnpmVersion(p, name) ?? yarnVersion(p);
  return { name, installPath, ...(version ? { version } : {}) };
}

// node_modules/.pnpm/date-fns@2.30.0/node_modules/date-fns, @scope+name@1.0.0_peer@2…: the version
// before any peer suffix.
function pnpmVersion(p, name) {
  const m = /\.pnpm\/((?:@[^+/]+\+)?[^@/]+)@([^/_(]+)/.exec(p);
  if (!m || m[1].replace('+', '/') !== name) return null;
  return m[2];
}

// .yarn/cache/date-fns-npm-2.30.0-1a2b3c4d5e.zip/node_modules/date-fns
function yarnVersion(p) {
  return /-npm-(\d[^/]*?)-[0-9a-f]{6,}\.zip\//.exec(p)?.[1] ?? null;
}

/** The package that asked for a nested install: node_modules/a/node_modules/b → a; hoisted → null. */
export function parentOf(installPath) {
  const parts = String(installPath).split(NM).filter(Boolean);
  if (parts.length < 2) return null;
  return parts.at(-2).replace(/\/$/, '');
}

const numeric = (s) => String(s ?? '').split(/[.+-]/);

/** Compares two versions as npm's are written (1.10.0 after 1.9.2; a pre-release before its release). */
export function compareVersions(a, b) {
  const [ma, pa = ''] = String(a ?? '').split('-', 2);
  const [mb, pb = ''] = String(b ?? '').split('-', 2);
  const xa = numeric(ma);
  const xb = numeric(mb);
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    const d = (Number(xa[i]) || 0) - (Number(xb[i]) || 0);
    if (d) return d;
  }
  if (pa && !pb) return -1;
  if (pb && !pa) return 1;
  return pa.localeCompare(pb);
}

/** "4.1.0" → "4"; "0.28.1" → "0.28", where a minor version is a major one. */
export function majorOf(version) {
  const [major, minor] = String(version ?? '').split('.');
  if (!major) return '';
  return major === '0' && minor != null ? `0.${minor}` : major;
}

/** A package name npm would accept, for the /why line Ballast puts in Bilge's prompt. */
export const safePackageName = (name) => /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(String(name ?? ''));
