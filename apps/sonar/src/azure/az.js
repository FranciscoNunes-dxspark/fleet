// The Azure CLI's sign-in, which is all Sonar uses: tokens come from `az account get-access-token`,
// as Trawl and Keel get theirs, so Sonar never sees a password or keeps a secret.
import { run } from '../run.js';

// Tokens last about an hour; one is used until five minutes before it runs out.
const MARGIN_MS = 5 * 60 * 1000;
const cache = new Map();
// Tokens being fetched: the calls that ask at once (a load starts several) share one az run.
const pending = new Map();

/** What `az` said, as JSON; signing in again is the answer when it says the sign-in has run out. */
async function az(args, { runner = run, signal } = {}) {
  try {
    const { stdout } = await runner(`az ${args} -o json`, { signal });
    return JSON.parse(stdout);
  } catch (e) {
    if (e.cancelled) throw e;
    const text = `${e.stderr ?? ''} ${e.message}`;
    if (/az login|AADSTS|refresh token|not logged in/i.test(text)) throw new Error('The Azure CLI is not signed in, or its sign-in ran out: run az login');
    if (/not recognized|not found|ENOENT/i.test(text)) throw new Error('The Azure CLI (az) is not installed. Get it from https://aka.ms/azure-cli');
    throw e;
  }
}

/** An access token for `resource` (ARM, App Insights' API…), kept until shortly before it expires. */
export async function token(resource, { now = Date.now(), runner } = {}) {
  const hit = cache.get(resource);
  if (hit && hit.expires - MARGIN_MS > now) return hit.token;
  if (pending.has(resource)) return pending.get(resource);
  const p = az(`account get-access-token --resource "${resource}" --query "{token:accessToken,expires:expires_on,expiresOn:expiresOn}"`, { runner })
    .then((out) => {
      // expires_on is seconds since 1970 in newer CLIs; older ones only give expiresOn, a local time.
      const expires = out.expires ? Number(out.expires) * 1000 : Date.parse(out.expiresOn) || now + 30 * 60 * 1000;
      cache.set(resource, { token: out.token, expires });
      return out.token;
    })
    .finally(() => pending.delete(resource));
  pending.set(resource, p);
  return p;
}

/** The subscription `az` has selected (az account set), to start on: { id, name }. */
export async function currentSubscription({ runner } = {}) {
  const out = await az('account show --query "{id:id,name:name}"', { runner });
  return out?.id ? out : null;
}
