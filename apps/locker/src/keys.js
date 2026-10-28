// What makes two sources' keys the same setting, and Key Vault references. Pure.
//
// .NET reads Section:Key from appsettings.json, Section__Key from the environment (and so from App
// Service's settings on Linux and a .env file), and Section--Key from Key Vault (its names allow
// neither : nor _), all case-insensitively: they are one setting, and one row in the drift view.

/** A key as every source's spelling of it compares: __ and -- as :, lower case. */
export const normKey = (key) => String(key ?? '').replace(/__/g, ':').replace(/--/g, ':').toLowerCase();

/** The Key Vault secret name a configuration key is written as (Db:Password → Db--Password); other characters a name can't have become -. */
export const vaultName = (key) =>
  String(key ?? '')
    .replace(/__|:/g, '--')
    .replace(/[^0-9A-Za-z-]/g, '-')
    .slice(0, 127);

/** Whether `name` can be a Key Vault secret's name: 1 to 127 letters, digits and dashes. */
export const isVaultName = (name) => /^[0-9A-Za-z-]{1,127}$/.test(String(name ?? ''));

/** Whether a setting's value is a Key Vault reference (@Microsoft.KeyVault(…)) rather than a value. */
export const isReference = (value) => /^\s*@Microsoft\.KeyVault\(/i.test(String(value ?? ''));

/**
 * A Key Vault reference read: { vault, secret, version } (vault the vault's name, version null for the
 * latest), from either form App Service takes, SecretUri=https://<vault>.vault.azure.net/secrets/<name>[/<version>]
 * or VaultName=…;SecretName=…;SecretVersion=…; null when it isn't one, or { problem } when it's written wrong.
 */
export function parseReference(value) {
  const m = /^\s*@Microsoft\.KeyVault\((.*)\)\s*$/is.exec(String(value ?? ''));
  if (!m) return null;
  const fields = {};
  for (const part of m[1].split(';')) {
    const at = part.indexOf('=');
    if (at > 0) fields[part.slice(0, at).trim().toLowerCase()] = part.slice(at + 1).trim();
  }
  if (fields.secreturi) {
    const u = /^https:\/\/([^./]+)\.vault\.[^/]+\/secrets\/([^/?]+)(?:\/([^/?]*))?\/?(?:\?.*)?$/i.exec(fields.secreturi);
    if (!u) return { problem: 'SecretUri is not a Key Vault secret address' };
    return { vault: u[1].toLowerCase(), secret: u[2], version: u[3] || null };
  }
  if (fields.vaultname && fields.secretname) return { vault: fields.vaultname.toLowerCase(), secret: fields.secretname, version: fields.secretversion || null };
  return { problem: 'it names neither a SecretUri nor a VaultName and SecretName' };
}

/** A reference in a few words: vault/secret[@version]. */
export const referenceText = (ref) => (ref?.problem ? `written wrong: ${ref.problem}` : `${ref.vault}/${ref.secret}${ref.version ? `@${ref.version.slice(0, 8)}` : ''}`);
