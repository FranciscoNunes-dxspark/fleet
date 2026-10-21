const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** The host of PUBLIC_URL (e.g. "keel.example.com" for https://keel.example.com), or null. */
export function publicHost(url = process.env.PUBLIC_URL) {
  try {
    return url?.trim() ? new URL(url.trim()).hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

// The address Keel is published at (PUBLIC_URL) is allowed without repeating it in ALLOWED_HOSTS.
const allowedHosts = new Set([
  ...LOOPBACK,
  ...(process.env.ALLOWED_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
  ...[publicHost()].filter(Boolean),
]);

const hostname = (hostHeader = '') => hostHeader.toLowerCase().replace(/:\d+$/, '');

/**
 * DNS-rebinding guard. A malicious site can point its own domain at
 * 127.0.0.1; the browser then treats this server as same-origin with that
 * site. Checking the Host header shuts that down: only localhost (or hosts you
 * list in ALLOWED_HOSTS, or PUBLIC_URL's host) are served.
 */
export function hostGuard(req, res, next) {
  if (!allowedHosts.has(hostname(req.headers.host))) {
    return res.status(421).type('text').send('Unknown host. Set PUBLIC_URL, or add it to ALLOWED_HOSTS, if you really mean to serve it.');
  }
  // Writes must come from a page on an allowed host (blocks cross-site form posts).
  const origin = req.headers.origin;
  if (req.method !== 'GET' && req.method !== 'HEAD' && origin) {
    let ok = false;
    try {
      ok = allowedHosts.has(new URL(origin).hostname.toLowerCase()) || allowedHosts.has(`[${new URL(origin).hostname}]`);
    } catch {
      ok = false;
    }
    if (!ok) return res.status(403).json({ error: 'Cross-origin request blocked' });
  }
  return next();
}

/** Conservative browser security headers for the API and the built UI. */
export function securityHeaders(req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    // Inline style attributes are used by React components; scripts are bundle-only. WebAssembly may be
    // compiled (not eval'd JavaScript): the terminal app's page (/cli) lays out with Ink's Yoga, which
    // reads its module from a data: URL in the bundle.
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self' 'wasm-unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self' data:",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
  });
  if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
  next();
}

