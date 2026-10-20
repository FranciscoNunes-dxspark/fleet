// GitHub sign-in through the GitHub CLI: the token comes from `gh auth login`, so nothing is
// stored. Used when there is no GITHUB_TOKEN, as azcli.js does for Azure DevOps.
import { execFile } from 'node:child_process';

function gh(args) {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      if (err.code === 'ENOENT') return reject(new Error('The GitHub CLI (gh) is not installed or not on the PATH. Get it from https://cli.github.com, or set GITHUB_TOKEN.'));
      const text = (stderr || err.message).trim().split('\n').slice(-3).join('\n');
      reject(new Error(/auth login/.test(text) ? `Not signed in to GitHub. Run: gh auth login\n${text}` : text || 'gh failed'));
    });
  });
}

/**
 * A function giving a GitHub token for `host` from the GitHub CLI's sign-in. gh's tokens don't
 * expire on a timer, so it's asked again only every 30 minutes (a `gh auth refresh` shows up then).
 */
export function githubCliToken(host = 'github.com', { run = gh } = {}) {
  let cached = null;
  let pending = null;
  return async function token() {
    if (cached && Date.now() < cached.until) return cached.value;
    pending ??= run(['auth', 'token', '--hostname', host])
      .then((out) => {
        const value = out.trim();
        if (!value) throw new Error('The GitHub CLI returned no token. Run: gh auth login');
        cached = { value, until: Date.now() + 30 * 60_000 };
        return value;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };
}
