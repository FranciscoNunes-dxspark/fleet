// Each organization's provider, by its kind: Azure DevOps (azdo/) or a GitHub owner (github/),
// or their demo versions. Used by local mode, sign-in mode and the terminal app alike.
import { config } from './config.js';
import { createAzdoProvider } from './azdo/provider.js';
import { createGithubProvider, githubTarget } from './github/provider.js';
import { githubCliToken } from './github/ghcli.js';
import { createMockProvider } from './mock/provider.js';
import { createMockVariant } from './mock/variant.js';
import { createMockGithub } from './mock/github.js';

// One GitHub CLI sign-in per host, shared by every GitHub owner on it.
const cliTokens = new Map();
const cliToken = (host) => {
  if (!cliTokens.has(host)) cliTokens.set(host, githubCliToken(host));
  return cliTokens.get(host);
};

/**
 * `personal`: a person's own token for this organization (sign-in mode). Without one, Azure
 * DevOps uses AZDO_PAT or `azToken` (the Azure CLI's sign-in), and GitHub uses GITHUB_TOKEN or
 * the GitHub CLI's sign-in (`gh auth login`).
 */
export function providerFor(org, { personal, azToken } = {}) {
  if (config.mock) {
    if (org.kind === 'github') return createMockGithub(org);
    return org.primary ? createMockProvider() : createMockVariant();
  }
  if (org.kind === 'github') {
    return createGithubProvider({ org, token: personal || config.githubToken || cliToken(githubTarget(org.url).host) });
  }
  return createAzdoProvider({ orgUrl: org.url, pat: personal ?? config.pat, token: personal ? undefined : azToken });
}
