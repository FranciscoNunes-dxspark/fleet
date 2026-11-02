// .NET's target frameworks (net8.0, net48, netstandard2.0, .NETFramework4.6.2, .NETCoreApp,Version=v8.0)
// read and compared: whether a package built for one runs in a project that targets another. Pure.
// What NuGet itself does, cut down to the families a project targets today: .NET (and .NET Core),
// .NET Framework and .NET Standard, with a platform (net8.0-windows) kept apart.

/** { family: 'core'|'fx'|'std', version: [numbers], platform, name } for a framework, or null for one Bilge doesn't know. */
export function parseFramework(text) {
  const s = String(text ?? '').trim().toLowerCase().split('/')[0].replace(/^\./, '');
  const m = /^(netframework|netstandard|netcoreapp|net)(?:,version=v)?(\d[\d.]*)(?:-([a-z]+)[\d.]*)?$/.exec(s);
  if (!m) return null;
  const [, kind, v, platform = null] = m;
  // net462 and net48 are the .NET Framework's short names; net5.0 and later are .NET's.
  const version = kind === 'net' && !v.includes('.') ? [...v].map(Number) : v.split('.').filter(Boolean).map(Number);
  const family = kind === 'netstandard' ? 'std' : kind === 'netcoreapp' || (kind === 'net' && v.includes('.') && version[0] >= 5) ? 'core' : 'fx';
  if (family !== 'core' && platform) return null;
  return { family, version, platform, name: frameworkName({ family, version, platform }) };
}

/** A framework's short name, as a project file writes it: net8.0, netcoreapp3.1, net48, netstandard2.0, net8.0-windows. */
export function frameworkName({ family, version, platform }) {
  const dotted = [version[0] ?? 0, version[1] ?? 0, ...version.slice(2).filter((_, i, all) => all.slice(i).some(Boolean))].join('.');
  if (family === 'fx') return `net${version.join('')}`;
  if (family === 'std') return `netstandard${dotted}`;
  return `${(version[0] ?? 0) >= 5 ? 'net' : 'netcoreapp'}${dotted}${platform ? `-${platform}` : ''}`;
}

const cmp = (a, b) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
};

// The oldest of each family that runs a given .NET Standard: .NET Core 2.0 and the .NET Framework 4.6.1
// run 2.0, only .NET Core 3.0 and later run 2.1.
const STANDARD = [
  [[1, 1], { core: [1, 0], fx: [4, 5] }],
  [[1, 2], { core: [1, 0], fx: [4, 5, 1] }],
  [[1, 3], { core: [1, 0], fx: [4, 6] }],
  [[1, 6], { core: [1, 0], fx: [4, 6, 1] }],
  [[2, 0], { core: [2, 0], fx: [4, 6, 1] }],
  [[2, 1], { core: [3, 0], fx: null }],
];

/** Whether a package's `built` framework runs in a project targeting `target` (both parsed). */
export function runsOn(built, target) {
  if (!built || !target) return false;
  if (built.platform && built.platform !== target.platform) return false;
  if (built.family === target.family) return cmp(built.version, target.version) <= 0;
  if (built.family !== 'std' || target.family === 'std') return false;
  const row = STANDARD.find(([std]) => cmp(built.version, std) <= 0);
  const oldest = row?.[1][target.family];
  return Boolean(oldest) && cmp(target.version, oldest) >= 0;
}

/**
 * Which of a project's `targets` (names) a package built for `built` (the frameworks its .nuspec groups
 * name; '' for a group that names none, which is for all of them) doesn't run on. Empty when it runs on
 * every one, or when Bilge can't tell: no list, or a framework it doesn't know (Xamarin, UWP, a portable
 * profile) that might be the one.
 */
export function unsupported(built, targets) {
  if (!built?.length || !targets?.length) return [];
  if (built.some((b) => !String(b).trim())) return [];
  const parsed = built.map(parseFramework);
  if (parsed.some((b) => !b)) return [];
  return targets.filter((t) => {
    const target = parseFramework(t);
    return target && !parsed.some((b) => runsOn(b, target));
  });
}

/** The frameworks a .NET project file targets: <TargetFramework> or <TargetFrameworks> (a;b), as short names. */
export function projectFrameworks(text) {
  const s = String(text ?? '');
  const raw = /<TargetFrameworks?>\s*([^<]+?)\s*<\/TargetFrameworks?>/i.exec(s)?.[1] ?? '';
  return [...new Set(raw.split(';').map((t) => parseFramework(t)?.name).filter(Boolean))];
}

/** A lock file's frameworks (its `dependencies` keys: net8.0, net8.0/win-x64, .NETCoreApp,Version=v8.0), as short names. */
export const lockFrameworks = (keys) => [...new Set(keys.map((k) => parseFramework(k)?.name).filter(Boolean))];

/** The frameworks a .nuspec's dependency and framework-reference groups name ('' for a group for all), or null when it has none. */
export function nuspecFrameworks(xml) {
  const groups = [...String(xml ?? '').matchAll(/<(?:group|frameworkReferenceGroup)\b([^>]*)>/gi)].map((m) => /\btargetFramework\s*=\s*"([^"]*)"/i.exec(m[1])?.[1] ?? '');
  return groups.length ? [...new Set(groups.map((g) => (g ? parseFramework(g)?.name ?? g : '')))] : null;
}
