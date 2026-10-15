import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  // No .env file: fall back to the real environment.
}

const orgUrl = (process.env.AZDO_ORG_URL || '').trim().replace(/\/+$/, '');
const pat = (process.env.AZDO_PAT || '').trim();
const mockRequested = process.argv.includes('--mock') || /^(1|true|yes)$/i.test(process.env.AZDO_MOCK || '');
// local: one user, PAT from .env. login: each person signs in with their own PAT.
const authMode = !mockRequested && orgUrl && /^login$/i.test(process.env.AUTH_MODE || '') ? 'login' : 'local';

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
  mock: mockRequested || !orgUrl || (authMode === 'local' && !pat),
  mockReason: mockRequested ? 'requested' : !orgUrl ? 'AZDO_ORG_URL not set' : (authMode === 'local' && !pat) ? 'AZDO_PAT not set' : null,
  dataDir: path.join(ROOT, 'data'),
  seedProjects: (process.env.AZDO_PROJECTS || '').split(',').map((s) => s.trim()).filter(Boolean),
};
