// Everything Lookout does that reaches beyond the screen goes through one object: the proxy (start,
// stop, configure), the certificate authority, the files it reads and writes, and the last session's
// findings. demo.js has the same interface for --demo and the tests; a new operation needs both.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createProxy } from './proxy.js';
import { caInfo, certCache, ensureCA, loadFindings, lookoutHome, saveFindings } from './store.js';

/**
 * The real thing. `home` is where the CA and the findings are kept (~/.lookout, LOOKOUT_HOME);
 * `upstreamCa` is a CA the forwarded HTTPS requests also trust (tests' origins).
 */
export function createLookout({ home = lookoutHome, upstreamCa = null } = {}) {
  const dir = () => (typeof home === 'function' ? home() : home);
  let proxy = null;
  let certs = null;
  const certsNow = () => (certs ??= certCache(ensureCA(dir()).ca));
  // The CA's state is read from the disk; the Setup view asks for it as it draws.
  let info = null;
  const infoNow = () => {
    if (!info || Date.now() - info.at > 2000) info = { at: Date.now(), value: caInfo(dir()) };
    return info.value;
  };

  return {
    demo: false,
    /** { exists, cert, fingerprint, paths: { dir, key, cert } } without making anything. */
    caInfo: () => infoNow(),
    /** Makes the CA when there's none: { made, paths, fingerprint }. */
    ensureCA() {
      const r = ensureCA(dir());
      info = null;
      return { made: r.made, paths: r.paths, fingerprint: caInfo(dir()).fingerprint };
    },
    /** Listens on 127.0.0.1:`port`; each change to an exchange goes to `onExchange`. Resolves { host, port }. */
    async start({ port, intercept = false, passThrough = [], maxBody, onExchange }) {
      await proxy?.close();
      proxy = createProxy({ certs: intercept ? certsNow() : null, intercept, passThrough, maxBody, upstreamCa, onExchange });
      try {
        return await proxy.listen(port);
      } catch (e) {
        proxy = null;
        throw e;
      }
    },
    async stop() {
      await proxy?.close();
      proxy = null;
    },
    /** { intercept, passThrough, maxBody, paused }, from the next connection on. */
    configure(next) {
      proxy?.configure({ ...next, ...(next.intercept ? { certs: certsNow() } : {}) });
    },
    get address() {
      return proxy?.address ?? null;
    },
    readFile: (path) => readFileSync(path, 'utf8'),
    exists: (path) => existsSync(path),
    writeFile: (path, text) => writeFileSync(path, text),
    saveFindings: (json) => saveFindings(json, dir()),
    loadFindings: () => loadFindings(dir()),
  };
}
