import path from 'node:path';
import { ROOT } from './root.js';

export { ROOT };

try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  // No .env file: fall back to the real environment.
}

/**
 * Where accounts, sessions and settings live. DATA_DIR wins. Hosts that build
 * every deploy into a fresh folder would wipe a data/ folder inside the app
 * (Hostinger: ~/domains/<site>/hbuilds/versions/<build>/nodejs), so there it
 * goes next to hbuilds instead: ~/domains/<site>/keel-data.
 */
export function dataDirFor(root, env = process.env) {
  if (env.DATA_DIR?.trim()) return path.resolve(root, env.DATA_DIR.trim());
  const hostinger = root.replace(/\\/g, '/').match(/^(.*)\/hbuilds\//);
  if (hostinger) return path.join(hostinger[1], 'keel-data');
  return path.join(root, 'data');
}

const orgUrl = (process.env.AZDO_ORG_URL || '').trim().replace(/\/+$/, '');
const pat = (process.env.AZDO_PAT || '').trim();
// Local mode (the server or the terminal app, cli/) can use your Azure CLI sign-in instead of a PAT: AZDO_AUTH=az.
const azAuth = /^az$/i.test((process.env.AZDO_AUTH || '').trim());
const mockRequested = process.argv.includes('--mock') || /^(1|true|yes)$/i.test(process.env.AZDO_MOCK || '');
// local: one user, PAT from .env. login: each person signs in with their own PAT.
// Sign-in also works on demo data, to try accounts and roles before deploying.
const authMode = (orgUrl || mockRequested) && /^login$/i.test(process.env.AUTH_MODE || '') ? 'login' : 'local';

export const config = {
  root: ROOT,
  port: Number(process.env.API_PORT) || 4280,
  // Bound to loopback by default: the server holds your PAT and acts as you.
  host: process.env.HOST || '127.0.0.1',
  orgUrl,
  pat,
  apiVersion: process.env.AZDO_API_VERSION || '7.1',
  maxConcurrency: Number(process.env.AZDO_MAX_CONCURRENCY) || 6,
  authMode,
  // Behind a reverse proxy (Hostinger, nginx...): set TRUST_PROXY=1 so HTTPS and client IPs are seen correctly.
  trustProxy: process.env.TRUST_PROXY || null,
  azAuth,
  mock: mockRequested || !orgUrl || (authMode === 'local' && !pat && !azAuth),
  mockReason: mockRequested ? 'requested' : !orgUrl ? 'AZDO_ORG_URL not set' : (authMode === 'local' && !pat && !azAuth) ? 'AZDO_PAT not set' : null,
  // GitHub sources (orgs.js) in local mode and the terminal app; without it, the GitHub CLI's sign-in.
  githubToken: (process.env.GITHUB_TOKEN || '').trim(),
  dataDir: dataDirFor(ROOT),
  // The Android app (scripts/build-android.mjs): its package and signing certificate(s), for /.well-known/assetlinks.json.
  androidPackage: (process.env.ANDROID_PACKAGE || '').trim() || 'com.example.keel',
  androidCertSha256: (process.env.ANDROID_CERT_SHA256 || '').trim(),
  seedProjects: (process.env.AZDO_PROJECTS || '').split(',').map((s) => s.trim()).filter(Boolean),
};
