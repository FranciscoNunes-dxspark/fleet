// Azure DevOps sign-in through the Azure CLI: the token comes from `az login`, so nothing is
// stored. Used by the terminal app (cli/) when there is no PAT; the same approach as Trawl's.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

// Azure DevOps' application id, the resource its Entra tokens are issued for.
const RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';

// On Windows az is a .cmd wrapper that Node won't start without a shell, so call the Python
// it wraps directly: no shell, so no quoting surprises. (As Tiller and Trawl do.)
function az(args, { signal } = {}) {
  let file = 'az';
  let argv = args;
  let env = process.env;
  if (process.platform === 'win32') {
    const dir = (process.env.PATH ?? '').split(delimiter).find((d) => d && existsSync(join(d, 'az.cmd')));
    const python = dir && join(dir, '..', 'python.exe');
    if (!python || !existsSync(python)) return Promise.reject(new Error('The Azure CLI (az) is not installed. Get it from https://aka.ms/installazurecliwindows'));
    file = python;
    argv = ['-X', 'utf8', '-IBm', 'azure.cli', ...args];
    env = { ...process.env, AZ_INSTALLER: 'MSI' };
  }
  return new Promise((resolve, reject) => {
    execFile(file, argv, { env, signal, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      if (err.code === 'ENOENT') return reject(new Error('The Azure CLI (az) is not installed or not on the PATH.'));
      const lines = (stderr || err.message).trim().split('\n').filter((l) => !/^WARNING:/.test(l));
      const text = lines.slice(-3).join('\n');
      reject(new Error(/az login/.test(text) ? `Not signed in to Azure. Run: az login\n${text}` : text || 'az failed'));
    });
  });
}

/** When a token from `az account get-access-token` expires, in ms; older az versions only give a local time string. */
export function expiryOf(answer, now = Date.now()) {
  const epoch = Number(answer?.expires_on);
  if (Number.isFinite(epoch) && epoch > 0) return epoch * 1000;
  const local = Date.parse(answer?.expiresOn ?? '');
  return Number.isFinite(local) ? local : now + 45 * 60_000;
}

/**
 * A function giving an Azure DevOps access token from the Azure CLI's current sign-in, kept
 * until five minutes before it expires (tokens last about an hour). Calls at the same time share one az.
 */
export function azureDevOpsToken({ run = az } = {}) {
  let cached = null;
  let pending = null;
  return async function token() {
    if (cached && Date.now() < cached.until) return cached.value;
    pending ??= run(['account', 'get-access-token', '--resource', RESOURCE, '-o', 'json'])
      .then((out) => {
        const answer = JSON.parse(out);
        if (!answer.accessToken) throw new Error('The Azure CLI returned no token. Run: az login');
        cached = { value: answer.accessToken, until: expiryOf(answer) - 5 * 60_000 };
        return answer.accessToken;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };
}
