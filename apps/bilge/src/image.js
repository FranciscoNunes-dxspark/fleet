// A container image's operating-system packages, read without running anything inside it: the
// provider creates a container from the image (never started), copies the package database out of
// it (`docker cp <id>:<path> -`, which writes a tar stream) and removes it again. This reads that tar,
// dpkg's status (Debian, Ubuntu, distroless's status.d) or apk's installed database (Alpine), and
// /etc/os-release, and makes them a manifest of kind 'image' whose packages are in OSV's ecosystem for
// the distribution ("Debian:12", "Ubuntu:22.04:LTS", "Alpine:v3.20"). Pure.

/** The image references Bilge will put in a command line: a name, a tag, a digest, a registry's host and port. */
export const safeImage = (ref) => typeof ref === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/.test(ref) && !ref.includes('..');

/** A container id as docker prints it. */
export const safeContainerId = (id) => /^[0-9a-f]{12,64}$/.test(String(id ?? ''));

const cstring = (buf, from, len) => {
  const end = buf.indexOf(0, from);
  return buf.toString('utf8', from, end < 0 || end > from + len ? from + len : end);
};
const octal = (buf, from, len) => Number.parseInt(cstring(buf, from, len).trim() || '0', 8) || 0;

function headerOk(buf, at) {
  if (at + 512 > buf.length) return false;
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : buf[at + i];
  return sum === octal(buf, at + 148, 8);
}

/**
 * The files in a tar stream: [{ name, type, data }] (`type` '0' a file, '5' a folder, '2' a link).
 * Long names (GNU's L, pax's path) are followed. A header that doesn't add up (bytes lost in the
 * text the stream came through) is skipped by looking for the next one, so one damaged entry costs
 * only itself.
 */
export function readTar(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input ?? ''), 'utf8');
  const out = [];
  let at = 0;
  let longName = null;
  while (at + 512 <= buf.length) {
    if (buf[at] === 0 && buf.subarray(at, at + 512).every((b) => b === 0)) break;
    if (!headerOk(buf, at)) {
      // A long name was the damaged entry's, not the next one's.
      longName = null;
      const next = buf.indexOf('ustar', at + 258);
      if (next < 0) break;
      at = next - 257;
      continue;
    }
    const size = octal(buf, at + 124, 12);
    const type = String.fromCharCode(buf[at + 156] || 48);
    // POSIX's ustar has a prefix for long paths there; GNU's ("ustar  ") keeps times in the same place.
    const prefix = buf.toString('latin1', at + 257, at + 263) === 'ustar\0' ? cstring(buf, at + 345, 155) : '';
    const data = buf.subarray(at + 512, Math.min(buf.length, at + 512 + size));
    const name = longName ?? (prefix ? `${prefix}/${cstring(buf, at, 100)}` : cstring(buf, at, 100));
    longName = null;
    if (type === 'L') longName = data.toString('utf8').replace(/\0+$/, '');
    else if (type === 'x') longName = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString('utf8'))?.[1] ?? null;
    else if (type !== 'g') out.push({ name, type, data });
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

/** The text of every plain file in a tar stream, one after another (status.d's files make one status). */
export const tarText = (input) =>
  readTar(input)
    .filter((f) => f.type === '0' || f.type === '\0' || f.type === '7')
    .map((f) => f.data.toString('utf8'))
    .join('\n\n');

/** /etc/os-release, as text: its fields ({ ID, VERSION_ID, VERSION, PRETTY_NAME, ID_LIKE… }). */
export function parseOsRelease(text) {
  const out = {};
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
  }
  return out;
}

/**
 * The OSV ecosystem of the distribution os-release names: "Debian:12", "Ubuntu:22.04:LTS" (OSV marks
 * Ubuntu's long-term releases so), "Alpine:v3.20"; null for one OSV doesn't cover this way (or one with
 * no version, as Debian's testing).
 */
export function osvEcosystem(os) {
  const id = String(os?.ID ?? '').toLowerCase();
  const version = String(os?.VERSION_ID ?? '');
  if (id === 'debian' && /^\d+$/.test(version)) return `Debian:${version}`;
  if (id === 'ubuntu' && /^\d+\.\d+$/.test(version)) return `Ubuntu:${version}${/\bLTS\b/.test(os.VERSION ?? '') ? ':LTS' : ''}`;
  if (id === 'alpine' && /^\d+\.\d+/.test(version)) return `Alpine:v${version.split('.').slice(0, 2).join('.')}`;
  return null;
}

// The paragraphs of dpkg's status and apk's database: blank-line separated, as { field: value } with their first line.
function paragraphs(text, split) {
  const out = [];
  let cur = null;
  let last = null;
  String(text ?? '')
    .split(/\r?\n/)
    .forEach((line, i) => {
      if (!line.trim()) {
        if (cur) out.push(cur);
        cur = null;
        last = null;
        return;
      }
      cur ??= { fields: {}, line: i + 1 };
      if (/^\s/.test(line) && last) {
        cur.fields[last] += `\n${line.trim()}`;
        return;
      }
      const kv = split(line);
      if (!kv) return;
      last = kv[0];
      cur.fields[kv[0]] ??= kv[1];
    });
  if (cur) out.push(cur);
  return out;
}

/**
 * dpkg's status, as text: the installed packages, by their source package (what Debian's and Ubuntu's
 * advisories name: glibc, not libc6), each source and version once, with its binary packages.
 */
export function parseDpkgStatus(text) {
  const out = new Map();
  for (const { fields } of paragraphs(text, (l) => /^([\w-]+):\s?(.*)$/.exec(l)?.slice(1))) {
    const status = fields.Status;
    // distroless's status.d says nothing about the state: everything in it is installed.
    if (!fields.Package || !fields.Version || (status && !/(^|\s)installed$/.test(status.trim()))) continue;
    const src = /^(\S+)(?:\s+\(([^)]+)\))?/.exec(fields.Source ?? '');
    const name = src?.[1] ?? fields.Package;
    const version = src?.[2] ?? fields.Version;
    const key = `${name}@${version}`;
    const had = out.get(key);
    if (had) had.binaries.push(fields.Package);
    else out.set(key, { name, version, binaries: [fields.Package] });
  }
  return [...out.values()];
}

/** apk's installed database (/lib/apk/db/installed), as text: by origin (Alpine's advisories' names), with the licence. */
export function parseApkInstalled(text) {
  const out = new Map();
  for (const { fields } of paragraphs(text, (l) => /^(\w):(.*)$/.exec(l)?.slice(1))) {
    if (!fields.P || !fields.V) continue;
    const name = fields.o || fields.P;
    const key = `${name}@${fields.V}`;
    const had = out.get(key);
    if (had) had.binaries.push(fields.P);
    else out.set(key, { name, version: fields.V, binaries: [fields.P], ...(fields.L ? { license: fields.L } : {}) });
  }
  return [...out.values()];
}

/**
 * The manifest of an image: { path: 'image <ref>', ecosystem, kind: 'image', image, os, packages, note }
 * from what was copied out of it (`db`: { kind: 'dpkg'|'apk', text }, `osRelease`: text). A
 * distribution OSV doesn't cover gives no packages, and says so.
 */
export function imageManifest(image, { db, osRelease }) {
  const os = parseOsRelease(osRelease);
  const ecosystem = osvEcosystem(os);
  const pretty = os.PRETTY_NAME || [os.ID, os.VERSION_ID].filter(Boolean).join(' ') || 'an unknown system';
  const base = { path: `image ${image}`, file: null, dir: null, kind: 'image', image, os: pretty };
  if (!db) return { ...base, ecosystem: ecosystem ?? 'image', packages: [], note: `${pretty}: no dpkg or apk database in it (distroless static, scratch, or an RPM-based system)` };
  if (!ecosystem) return { ...base, ecosystem: 'image', packages: [], note: `${pretty}: not a distribution OSV covers by version (Debian, Ubuntu and Alpine are)` };
  const list = db.kind === 'apk' ? parseApkInstalled(db.text) : parseDpkgStatus(db.text);
  const packages = list.map(({ binaries, ...p }) => ({ ecosystem, ...p, direct: true, dev: false, ...(binaries.length > 1 || binaries[0] !== p.name ? { binaries } : {}) }));
  return { ...base, ecosystem, packages, note: `${pretty}, ${packages.length} ${db.kind} source packages` };
}
