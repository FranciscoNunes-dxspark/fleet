// The Android app (scripts/build-android.mjs) is a Trusted Web Activity: Chrome
// opens Keel full screen, without its address bar, only once this server vouches
// for the app with a Digital Asset Links statement at /.well-known/assetlinks.json.

/** "aa:bb:…" or plain hex → the colon-separated upper-case form Android expects, or null when it isn't a SHA-256. */
export function normalizeFingerprint(value) {
  const hex = String(value || '').replace(/[\s:]/g, '').toUpperCase();
  return /^[0-9A-F]{64}$/.test(hex) ? hex.match(/../g).join(':') : null;
}

/**
 * The assetlinks.json body for the Android app, or null when no signing
 * certificate is set. Several fingerprints are allowed: a local build's key and
 * Google Play's app signing key, say.
 */
export function assetLinks({ packageId, fingerprints }) {
  const certs = [...new Set(String(fingerprints || '').split(',').map(normalizeFingerprint).filter(Boolean))];
  if (!packageId || !certs.length) return null;
  return [{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: { namespace: 'android_app', package_name: packageId, sha256_cert_fingerprints: certs },
  }];
}
