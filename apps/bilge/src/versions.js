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

// npm's ranges (^1.2.3, ~1.2, >=18 <21, 1.x, 1.2 - 2, a || b), as comparators. Enough of semver for
// what engines and peerDependencies say; a pre-release is compared as any other version.
const PARTIAL = /^v?(\d+|[xX*])?(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** A partial version's numbers ([1, 2] for 1.2, [] for * or x) and its pre-release. */
function partial(text) {
  const m = PARTIAL.exec(text);
  if (!m) return null;
  const nums = [];
  for (const n of m.slice(1, 4)) {
    if (n === undefined || /[xX*]/.test(n)) break;
    nums.push(Number(n));
  }
  return { nums, pre: m[4] && nums.length === 3 ? `-${m[4]}` : '' };
}

const join3 = (nums, pre = '') => `${nums[0] ?? 0}.${nums[1] ?? 0}.${nums[2] ?? 0}${pre}`;
/** The version just past a partial's last number: 1.2 → 1.3.0, 1 → 2.0.0. */
const pastPartial = (nums) => join3(nums.map((n, i) => (i === nums.length - 1 ? n + 1 : n)));

/** One comparator (^1.2, >=3, 1.x, =1.2.3), as [[op, version]], or null when it isn't one. */
function comparator(text) {
  const m = /^(\^|~>?|>=|<=|>|<|=)?(.*)$/.exec(text);
  const op = m[1] ?? '';
  const v = partial(m[2]);
  if (!v) return null;
  const { nums, pre } = v;
  if (!nums.length) return op === '<' || op === '>' ? [['<', '0.0.0']] : [];
  const full = nums.length === 3;
  switch (op) {
    case '^': {
      const at = nums.findIndex((n, i) => n !== 0 || i === nums.length - 1);
      const upper = nums.length < 3 && at === nums.length - 1 && nums[at] === 0 ? pastPartial(nums) : pastPartial(nums.slice(0, at + 1));
      return [['>=', join3(nums, pre)], ['<', upper]];
    }
    case '~':
    case '~>':
      return [['>=', join3(nums, pre)], ['<', pastPartial(nums.length === 1 ? nums : nums.slice(0, 2))]];
    case '>':
      return full ? [['>', join3(nums, pre)]] : [['>=', pastPartial(nums)]];
    case '>=':
      return [['>=', join3(nums, pre)]];
    case '<':
      return [['<', join3(nums, pre)]];
    case '<=':
      return full ? [['<=', join3(nums, pre)]] : [['<', pastPartial(nums)]];
    default:
      return full ? [['=', join3(nums, pre)]] : [['>=', join3(nums)], ['<', pastPartial(nums)]];
  }
}

/** A range as its alternatives, each a list of [op, version]; null when it can't be read. */
export function parseRange(range) {
  const text = String(range ?? '').trim();
  const sets = [];
  for (const alt of (text || '*').split('||')) {
    const s = alt.trim().replace(/(\^|~>?|>=|<=|>|<|=)\s+/g, '$1');
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(s);
    const parts = hyphen ? [`>=${hyphen[1]}`, `<=${hyphen[2]}`] : s.split(/\s+/).filter(Boolean);
    const set = [];
    for (const p of parts.length ? parts : ['*']) {
      const c = comparator(p);
      if (!c) return null;
      set.push(...c);
    }
    sets.push(set);
  }
  return sets;
}

const holds = (v, [op, w]) => {
  const d = compareVersions(v, w);
  return { '=': d === 0, '>': d > 0, '>=': d >= 0, '<': d < 0, '<=': d <= 0 }[op];
};

/** Whether `version` is in `range`; null when the range can't be read (a URL, a tag). */
export function satisfies(version, range) {
  const sets = parseRange(range);
  if (!sets) return null;
  return sets.some((set) => set.every((c) => holds(version, c)));
}

/** The lowest version `range` lets in (its lowest bound; 0.0.0 when it has none), or null when it can't be read. */
export function lowestIn(range) {
  const sets = parseRange(range);
  if (!sets) return null;
  const lows = sets.map((set) => {
    let low = '0.0.0';
    for (const [op, w] of set) {
      const at = op === '>' ? pastPartial(parseVersion(w).parts.slice(0, 3)) : op === '>=' || op === '=' ? w : null;
      if (at && compareVersions(at, low) > 0) low = at;
    }
    return low;
  });
  return lows.sort(compareVersions)[0];
}
