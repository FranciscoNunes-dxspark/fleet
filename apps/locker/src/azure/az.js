// The Azure CLI's sign-in, which is all Locker uses: tokens come from `az account get-access-token`,
// as Sonar, Trawl and Keel get theirs, so Locker never sees a password or keeps a credential.
import { run } from '@fleet/kit/run.js';

// Tokens last about an hour; one is used until five minutes before it runs out.
const MARGIN_MS = 5 * 60 * 1000;
const cache = new Map();
// Tokens being fetched: the calls that ask at once (a load starts several) share one az run.
const pending = new Map();

/** Sign-in trouble in words: "run az login" when the sign-in is missing or ran out, how to get az when it isn't there. */
export function azProblem(text) {
  const s = String(text ?? '');
  if (/az login|AADSTS|refresh token|not logged in|Please run 'az login'/i.test(s)) return 'The Azure CLI is not signed in, or its sign-in ran out: run az login';
  if (/not recognized|command not found|ENOENT|az: not found/i.test(s)) return 'The Azure CLI (az) is not installed. Get it from https://aka.ms/azure-cli';
  return null;
}

/** What `az` said, as JSON; signing in again is the answer when it says the sign-in has run out. */
async function az(args, { runner = run, signal } = {}) {
  try {
    const { stdout } = await runner(`az ${args} -o json`, { signal });
    return JSON.parse(stdout);
  } catch (e) {
    if (e.cancelled) throw e;
    const problem = azProblem(`${e.stderr ?? ''} ${e.message}`);
    throw problem ? new Error(problem) : e;
  }
}

/** An access token for `resource` (ARM, Key Vault), kept until shortly before it expires. */
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

/** Forgets the tokens (tests, and after az login in another terminal). */
export const forgetTokens = () => cache.clear();

/** The subscription `az` has selected (az account set), to start on: { id, name }. */
export async function currentSubscription({ runner } = {}) {
  const out = await az('account show --query "{id:id,name:name}"', { runner });
  return out?.id ? out : null;
}
