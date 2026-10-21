// The same service the web server builds in local mode (server/index.js), without the server:
// one per organization, wrapped by multiorg.js, reading and writing the same data folder, so
// tracked projects, snoozes and settings are shared with the browser. (Signed in to a Keel
// server instead, the app gets the same shape from remote.js.)
// Import this only after cli.jsx has set the environment: config.js reads it on import.
import { config } from '../server/config.js';
import { createService } from '../server/service.js';
import { createMultiService } from '../server/multiorg.js';
import { createOrgStore } from '../server/orgs.js';
import { createSettingsStore, defaultSettingsFile } from '../server/settings.js';
import { providerFor } from '../server/providers.js';
import { azureDevOpsToken } from '../server/azdo/azcli.js';
import { diffSnapshots } from '../server/domain/changes.js';
import { MAX_INTERVAL, MIN_INTERVAL } from '../server/watcher.js';

// As the web server's watcher (server/watcher.js): what a check drops so it really asks Azure DevOps.
const LIVE_PREFIXES = ['prs:active', 'pr:', 'wi:', 'builds'];

/**
 * Live checks in this process, as the web server's watcher does: `baseline` takes the first look
 * (which announces nothing, as in the browser), `check` asks Azure DevOps again and returns what
 * changed since, and `interval` is "refresh every" from Keel's settings, in seconds.
 */
export function localLive(service) {
  let prev = null;
  return {
    baseline: async () => {
      prev = await service.snapshot();
    },
    check: async () => {
      for (const prefix of LIVE_PREFIXES) service.invalidate(prefix);
      const snap = await service.snapshot();
      const notes = diffSnapshots(prev, snap);
      prev = snap;
      return notes;
    },
    interval: async () => Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, Number((await service.settingsStore.load()).refreshSeconds) || 60)),
  };
}

/**
 * `{ service, orgs, signIn, live, orgAdmin }`: signIn is 'demo', 'pat' (AZDO_PAT) or 'az' (the
 * Azure CLI's sign-in). Throws a sentence a person can act on when there's nothing to connect to.
 */
export function openKeel() {
  if (config.authMode === 'login') {
    throw new Error('This Keel uses sign-in (AUTH_MODE=login). To use your Keel account, run keel login <address>; otherwise run it with --demo, or without AUTH_MODE.');
  }
  const signIn = config.mock ? 'demo' : config.pat ? 'pat' : 'az';
  const token = signIn === 'az' ? azureDevOpsToken() : undefined;
  const orgStore = createOrgStore();
  const settings = createSettingsStore(defaultSettingsFile());
  const orgs = orgStore.all();
  const entries = orgs.map((org) => ({
    org,
    service: createService({
      provider: providerFor(org, { azToken: token }),
      settings,
      org,
    }),
  }));
  const service = createMultiService(entries);
  return { service, orgs, signIn, live: localLive(service), orgAdmin: { add: (org) => orgStore.add(org), remove: (key) => orgStore.remove(key) } };
}
