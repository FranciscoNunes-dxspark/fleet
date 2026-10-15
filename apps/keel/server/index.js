import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { config } from './config.js';
import { createService } from './service.js';
import { apiRouter } from './routes.js';
import { hostGuard, securityHeaders } from './security.js';
import { createWatcher } from './watcher.js';
import { createAuth } from './auth.js';
import { createMonitoring } from './monitoring.js';

const app = express();
app.disable('x-powered-by');
if (config.trustProxy) app.set('trust proxy', /^\d+$/.test(config.trustProxy) ? Number(config.trustProxy) : config.trustProxy);
app.use(hostGuard);
app.use(securityHeaders);

// Production checks run once per server and are shared by everyone using it.
const monitoring = createMonitoring();

if (config.authMode === 'login') {
  // Everyone signs in with their own PAT; each request runs as that person.
  const auth = createAuth({ monitoring });
  app.use('/api/auth', auth.router);
  app.use('/api/admin/users', auth.adminRouter);
  app.use('/api', auth.requireUser, apiRouter());
  auth.announceSetup();
} else {
  // One person: the PAT in .env (or demo data).
  const service = createService({ monitoring });
  // Local mode: the one person using it is the admin.
  const ctx = { service, watcher: createWatcher(service), role: 'admin', user: null };
  app.get('/api/auth/status', (req, res) => res.json({ mode: 'local', signedIn: true, orgUrl: service.provider.orgUrl }));
  app.use('/api', (req, res, next) => {
    req.ctx = ctx;
    next();
  }, apiRouter());
}

const dist = path.join(config.root, 'dist');
if (fs.existsSync(path.join(dist, 'index.html'))) {
  app.use(express.static(dist, { index: false, maxAge: '1h' }));
  app.get('/{*splat}', (req, res) => res.sendFile(path.join(dist, 'index.html')));
} else {
  app.get('/', (req, res) => res.type('text').send('UI not built. Run `npm run dev` (UI on http://localhost:5173) or `npm run build` first.'));
}

app.listen(config.port, config.host, () => {
  const mode = config.mock ? `DEMO DATA (${config.mockReason})` : config.authMode === 'login' ? `${config.orgUrl} · sign-in with personal PATs` : config.orgUrl;
  console.log(`Keel API on http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}  →  ${mode}`);
  if (config.authMode === 'login') {
    if (!process.env.SESSION_SECRET) console.warn('Note: SESSION_SECRET not set; using a generated key in data/secret.key. Keep the data/ folder private and backed up.');
    if (!config.trustProxy) console.warn('Note: TRUST_PROXY not set. Behind an HTTPS proxy, set TRUST_PROXY=1 so session cookies are marked Secure.');
  } else if (config.host !== '127.0.0.1' && config.host !== 'localhost') {
    console.warn('Warning: HOST is not loopback. Anyone who can reach this port can act on Azure DevOps as you. Use AUTH_MODE=login to require sign-in.');
  }
});
