// Where Lookout keeps what it keeps: ~/.lookout (LOOKOUT_HOME for tests), holding the settings, the
// local certificate authority and the last session's security findings. The CA's key never leaves this
// folder: it is written once, readable by the user alone (0600, the folder 0700) where the system has
// such permissions (not Windows, where the profile is the user's already).
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import { certHost, fingerprint, issue, makeCA, makeLeafKey } from './certs.js';

// Read per call so tests can point LOOKOUT_HOME somewhere temporary.
export const lookoutHome = (env = process.env) => env.LOOKOUT_HOME || join(homedir(), '.lookout');

/** Where the CA's two files are: { dir, key, cert }. */
export const caPaths = (home = lookoutHome()) => ({ dir: home, key: join(home, 'ca-key.pem'), cert: join(home, 'ca.crt') });

const privateFolder = (dir) => {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(dir, 0o700);
};

/** Writes `text` readable by the user alone (0600 off Windows), through a temporary file. */
export function writePrivate(file, text) {
  writeFileSync(`${file}.tmp`, text, { mode: 0o600 });
  if (process.platform !== 'win32') chmodSync(`${file}.tmp`, 0o600);
  renameSync(`${file}.tmp`, file);
}

/** The CA kept in `home` ({ key, cert } PEM), or null when none was made yet (or it can't be read). */
export function loadCA(home = lookoutHome()) {
  const p = caPaths(home);
  try {
    return { key: readFileSync(p.key, 'utf8'), cert: readFileSync(p.cert, 'utf8') };
  } catch {
    return null;
  }
}

/** The CA as it stands, without making one: { exists, cert, fingerprint, paths }. */
export function caInfo(home = lookoutHome()) {
  const paths = caPaths(home);
  const ca = existsSync(paths.cert) && existsSync(paths.key) ? loadCA(home) : null;
  return { exists: Boolean(ca), cert: ca?.cert ?? null, fingerprint: ca ? fingerprint(ca.cert) : null, paths };
}

/** The CA, made and kept the first time: { ca, made, paths }. */
export function ensureCA(home = lookoutHome(), { now = Date.now() } = {}) {
  const paths = caPaths(home);
  const kept = loadCA(home);
  if (kept) return { ca: kept, made: false, paths };
  privateFolder(home);
  const ca = makeCA({ now });
  writePrivate(paths.key, ca.key);
  // The certificate is public: it's what a trust store imports.
  writeFileSync(paths.cert, ca.cert);
  return { ca, made: true, paths };
}

const MAX_CACHED = 500;

/**
 * Certificates for the hosts Lookout intercepts, signed by `ca`, one key for all of them, each made
 * once and kept (as a TLS context) for the run: the first visit to a host pays for its certificate.
 */
export function certCache(ca, { now = () => Date.now() } = {}) {
  const leafKey = makeLeafKey();
  const contexts = new Map();
  return {
    ca,
    /** A secure context for `host`, or throws when the name can't be on a certificate. */
    contextFor(host) {
      const h = certHost(host);
      if (!h) throw new Error(`${host} isn't a host name a certificate can carry.`);
      let ctx = contexts.get(h);
      if (!ctx) {
        if (contexts.size >= MAX_CACHED) contexts.delete(contexts.keys().next().value);
        ctx = tls.createSecureContext({ key: leafKey, cert: issue(h, ca, leafKey, { now: now() }) });
        contexts.set(h, ctx);
      }
      return ctx;
    },
    /** The PEM certificate made for `host` (made now when it wasn't), for tests and the detail view. */
    certFor: (host) => issue(certHost(host), ca, leafKey, { now: now() }),
    get issued() {
      return contexts.size;
    },
  };
}

/** The last session's findings (security.js's), kept for `lookout security` without a HAR file. */
export const findingsFile = (home = lookoutHome()) => join(home, 'findings.json');

export function saveFindings(json, home = lookoutHome()) {
  try {
    privateFolder(home);
    writePrivate(findingsFile(home), JSON.stringify(json, null, 2));
  } catch {}
}

export function loadFindings(home = lookoutHome()) {
  try {
    return JSON.parse(readFileSync(findingsFile(home), 'utf8'));
  } catch {
    return null;
  }
}
