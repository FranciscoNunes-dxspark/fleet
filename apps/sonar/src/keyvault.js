// Key Vault references: settings written as @Microsoft.KeyVault(…), which App Service resolves with the
// app's managed identity. ARM says how each one went (azure/arm.js keyVaultReferences); this says it in
// words and picks out the ones that didn't resolve. Pure.

/** Whether a setting's value is a Key Vault reference rather than a value. */
export const isReference = (value) => /^\s*@Microsoft\.KeyVault\(/i.test(String(value ?? ''));

// ARM's statuses, in words.
const WORDS = {
  resolved: 'resolved',
  initialized: 'not resolved yet',
  invalidsyntax: 'the reference is written wrong',
  msinotenabled: 'the app has no managed identity',
  vaultnotfound: 'no such vault',
  secretnotfound: 'no such secret in the vault',
  secretversionnotfound: 'no such version of the secret',
  accesstokeyvaultdenied: "the app's identity may not read the vault",
  unauthorizedclient: "the app's identity isn't allowed",
  fetchtimedout: 'the vault took too long to answer',
  otherreasons: "couldn't be resolved",
};

/** Whether a reference resolved. */
export const resolved = (ref) => String(ref?.status ?? '').toLowerCase() === 'resolved';

/** A reference's status in words, ARM's details after it when it has any (and isn't resolved). */
export function referenceWords(ref) {
  const s = String(ref?.status ?? '');
  const words = WORDS[s.toLowerCase()] ?? (s ? s.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase() : 'unknown');
  return resolved(ref) || !ref?.details ? words : `${words} (${String(ref.details).split('\n')[0]})`;
}

/** The references that didn't resolve. */
export const unresolved = (refs) => (refs ?? []).filter((r) => !resolved(r));

/** A line about an app's references: "3: 2 resolved; Smtp__Password: the app's identity may not read the vault", or null with none. */
export function referencesSummary(refs) {
  if (!refs?.length) return null;
  const bad = unresolved(refs);
  const good = refs.length - bad.length;
  return `${refs.length}: ${good} resolved${bad.length ? `; ${bad.map((r) => `${r.name}: ${referenceWords(r)}`).join('; ')}` : ''}`;
}
