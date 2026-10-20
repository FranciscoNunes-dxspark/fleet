// The same service the web server builds in local mode (server/index.js), without the server:
// one per organization, wrapped by multiorg.js, reading and writing the same data folder, so
// tracked projects, snoozes and settings are shared with the browser.
// Import this only after cli.jsx has set the environment: config.js reads it on import.
import { config } from '../server/config.js';
import { createService } from '../server/service.js';
import { createMultiService } from '../server/multiorg.js';
import { createOrgStore } from '../server/orgs.js';
import { createSettingsStore, defaultSettingsFile } from '../server/settings.js';
import { providerFor } from '../server/providers.js';
import { azureDevOpsToken } from '../server/azdo/azcli.js';

/**
 * `{ service, orgs, signIn }`: signIn is 'demo', 'pat' (AZDO_PAT) or 'az' (the Azure CLI's sign-in).
 * Throws a sentence a person can act on when there's nothing to connect to.
 */
export function openKeel() {
  if (config.authMode === 'login') {
    throw new Error('This Keel uses sign-in (AUTH_MODE=login). The terminal app works in local mode: run it with --demo, or without AUTH_MODE.');
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
  return { service: createMultiService(entries), orgs, signIn };
}
