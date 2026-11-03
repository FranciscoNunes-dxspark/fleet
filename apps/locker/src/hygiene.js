// Secret hygiene: what Locker reads, judged for the habits that leak or lose a secret. A key vault's
// secrets and certificates (expired, about to, never set to, not rotated in a year, disabled while a
// setting still reads one) and the vault itself (purge protection, an open network); an App Service
// app's settings and connection strings holding a secret as plain text rather than a Key Vault
// reference, or one slot referring to the vault where another holds the value; the folder's files that
// git tracks with a secret in them; and the same secret in two environments (prod and dev sharing one).
//
// Pure: everything is judged from metadata (names, dates, flags) and from the shape of values Locker
// already holds, never by reading a vault secret's value. A finding is findings.js's shape and never
// holds a value: what was seen is cut to its first characters (codescan.js's `redact`), and a value is
// compared with another only by drift.js's keyed hash, made before it gets here.
import { RULES, redact } from '@fleet/kit/codescan.js';
import { sortFindings } from '@fleet/kit/findings.js';
import { isSecretName } from '@fleet/kit/family.js';
import { isReference, normKey, parseReference, vaultName } from './keys.js';
import { msLeft } from './expiry.js';

const DAY = 24 * 60 * 60 * 1000;

/** Days within which an expiry is high (WEEK) and medium (MONTH); days since a change that make a secret stale. */
export const LIMITS = { week: 7, month: 30, stale: 365, aging: 180 };

const siteLabel = (s) => (s ? `${s.name}${s.slot ? `/${s.slot}` : ''}` : '');

// ——— What looks like a secret ———

// The secret-shaped rules of the kit's code scan that apply to any text (not those for a Dockerfile).
const SHAPES = RULES.filter((r) => r.kind === 'secret' && !r.files);

// A last part of a name that says key without meaning a secret: an id, a public half, a non-secret.
const NOT_SECRET_KEY = /instrumentationkey|publickey|public_key|keyvault|key_?vault|keyid|key_?id|keyname|key_?name|partitionkey|rowkey|keytype|keysize|keyprefix|idempotencykey|cachekey|sortkey|primarykey|foreignkey|hotkey|keyboard|monkey|turkey/i;

/** Whether a setting's name says it holds a secret: password, secret, token, an API, access or account key, or a key of any kind. */
export function isSecretSetting(key) {
  const k = String(key ?? '');
  if (/^WEBSITE_|^FUNCTIONS_|^APPINSIGHTS_|^APPLICATIONINSIGHTS_|^ASPNETCORE_|^DOTNET_|^SCM_/i.test(k)) return false;
  const leaf = normKey(k).split(':').pop();
  if (NOT_SECRET_KEY.test(leaf)) return false;
  return isSecretName(leaf) || /key$/i.test(leaf);
}

// What only stands in for a value: empty, a variable or a template's hole, an obvious example, a flag.
const PLACEHOLDER = /^(\$\{.*\}|\$\(.*\)|\{\{.*\}\}|#\{.*\}#?|__\w+__|<[^>]*>|%[A-Za-z_]+%|\$[A-Z_][A-Z0-9_]*|xx+|\*+|•+|\.\.\.|your[-_ ].*|my[-_].*|example.*|placeholder.*|dummy.*|sample.*|redacted|change[-_ ]?me|todo|none|null|undefined|true|false|yes|no|on|off|enabled|disabled)$/i;

/** Whether `value` is something to judge: not empty, not a placeholder or flag, not a short number, not an address with no password in it. */
export function isLiteral(value) {
  const v = String(value ?? '').trim();
  if (!v || PLACEHOLDER.test(v) || isReference(v)) return false;
  if (/^\d{1,6}$/.test(v)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\/[^@\s]*$/i.test(v)) return false;
  return true;
}

/** The first secret shape the kit's code scan knows in `value`: { rule, secret } (the part that is the secret), or null. */
export function secretShape(value) {
  const line = String(value ?? '');
  for (const r of SHAPES) {
    const m = r.pattern.exec(line);
    if (!m || (r.accept && !r.accept(m, line))) continue;
    const secret = r.secret === undefined ? m[0] : (m[r.secret] ?? m[r.secret + 1] ?? m[0]);
    return { rule: r, secret };
  }
  return null;
}

/**
 * Whether a setting holds a secret as plain text: { shape (the code scan's rule, or null), excerpt }
 * where `excerpt` has the secret cut to its first characters; null when it is a reference, a
 * placeholder, or neither named nor shaped like a secret.
 */
export function plainSecret(key, value) {
  const v = String(value ?? '');
  if (!isLiteral(v)) return null;
  const shape = secretShape(v);
  if (shape) {
    let excerpt = v.split(shape.secret).join(redact(shape.secret)).trim();
    if (excerpt.length > 120) excerpt = `${excerpt.slice(0, 119)}…`;
    return { shape: shape.rule, excerpt: `${key}=${excerpt}` };
  }
  if (!isSecretSetting(key)) return null;
  // A connection string with nothing secret in it (managed identity, integrated sign-in) isn't one.
  if (/^\s*(Server|Data Source|Host|Endpoint|AccountName)\s*=/i.test(v) && /;/.test(v)) return null;
  return { shape: null, excerpt: `${key}=${redact(v.trim())}` };
}

// ——— Key Vault ———

/** A certificate's hex thumbprint (as WEBSITE_LOAD_CERTIFICATES lists them) from Key Vault's x5t, base64url SHA-1. */
export function thumbprintHex(x5t) {
  const s = String(x5t ?? '');
  if (/^[0-9a-f]{40}$/i.test(s)) return s.toUpperCase();
  try {
    const hex = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('hex').toUpperCase();
    return hex.length === 40 ? hex : '';
  } catch {
    return '';
  }
}

/**
 * What the apps read from Key Vault, from their settings: { secrets: Set of 'vault/secret' (lower
 * case), certificates: Set of hex thumbprints or '*' } (WEBSITE_LOAD_CERTIFICATES), and `by`, a Map
 * from 'vault/secret' to the settings that refer to it ('shop-api/Db__Password').
 */
export function vaultUse(sites = []) {
  const secrets = new Set();
  const certificates = new Set();
  const by = new Map();
  for (const { site, settings = {}, strings = {} } of sites) {
    const all = [...Object.entries(settings), ...Object.entries(strings).map(([k, s]) => [`ConnectionStrings:${k}`, s?.value])];
    for (const [key, value] of all) {
      if (/^WEBSITE_LOAD_CERTIFICATES$/i.test(key)) for (const t of String(value ?? '').split(/[,;\s]+/).filter(Boolean)) certificates.add(t === '*' ? '*' : t.toUpperCase());
      if (!isReference(value)) continue;
      const ref = parseReference(value);
      if (!ref?.vault) continue;
      const id = `${ref.vault}/${ref.secret}`.toLowerCase();
      secrets.add(id);
      by.set(id, [...(by.get(id) ?? []), `${siteLabel(site)}/${key}`]);
    }
  }
  return { secrets, certificates, by };
}

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const days = (ms) => Math.floor(Math.abs(ms) / DAY);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * A vault's secrets and certificates judged from what Key Vault lists of them (never their values):
 * expired, expiring within LIMITS.month or LIMITS.week days, no expiry set, not changed in
 * LIMITS.aging or LIMITS.stale days, disabled while a setting refers to it. `use` is vaultUse's.
 */
export function vaultItemFindings({ vault, secrets = [], certificates = [] }, { use = vaultUse(), now = Date.now() } = {}) {
  const out = [];
  const vname = vault.name;
  for (const item of [...secrets, ...certificates]) {
    if (item.managed) continue;
    const cert = item.kind === 'certificate';
    const what = cert ? 'certificate' : 'secret';
    const id = `${vname}/${item.name}`.toLowerCase();
    const referencedBy = use.by.get(id) ?? [];
    const thumb = cert ? thumbprintHex(item.thumbprint) : '';
    // A certificate is in use when a setting refers to it, or an app loads it (WEBSITE_LOAD_CERTIFICATES).
    const inUse = referencedBy.length > 0 || (cert && (use.certificates.has('*') || (thumb && use.certificates.has(thumb))));
    const base = { where: `${vname}/${item.name}`, scope: 'vault', vault: vname, name: item.name, itemKind: item.kind, kind: 'secret' };
    const readers = referencedBy.length ? ` ${referencedBy.join(', ')} ${referencedBy.length === 1 ? 'reads' : 'read'} it.` : '';
    if (item.enabled === false) {
      if (referencedBy.length)
        out.push({ ...base, rule: 'kv-disabled-referenced', severity: 'high', title: `Disabled ${what} still referred to`, why: `${item.name} is disabled in ${vname}, so the settings that refer to it get nothing.${readers}`, fix: `Enable it (az keyvault secret set-attributes --vault-name ${vname} --name ${item.name} --enabled true) or point the settings at the secret that replaced it.` });
      continue;
    }
    const left = msLeft(item.expires, now);
    if (left == null) {
      if (!cert)
        out.push({ ...base, rule: 'kv-no-expiry', severity: 'low', title: 'Secret with no expiry date', why: `${item.name} never expires, so nothing says when it is due to be rotated.`, fix: `Give it one when you next rotate it: az keyvault secret set-attributes --vault-name ${vname} --name ${item.name} --expires ${isoDay(now + 365 * DAY)}T00:00:00Z` });
    } else if (left <= 0) {
      out.push({
        ...base,
        rule: 'kv-expired',
        severity: cert && inUse ? 'critical' : 'high',
        title: cert ? `Expired certificate${inUse ? ' in use' : ''}` : 'Expired secret',
        why: `${item.name} expired ${days(left) ? `${plural(days(left), 'day')} ago` : 'today'} (${String(item.expires).slice(0, 10)}).${cert && inUse ? ' An app loads it, so what it secures is failing now.' : ''}${readers}`,
        fix: cert ? `Renew it: az keyvault certificate create --vault-name ${vname} -n ${item.name} -p "$(az keyvault certificate get-policy --vault-name ${vname} -n ${item.name})", then restart what loads it.` : `Rotate it (/rotate ${item.name}), or disable it if nothing uses it.`,
      });
    } else if (left <= LIMITS.month * DAY) {
      const soon = left <= LIMITS.week * DAY;
      const n = Math.ceil(left / DAY);
      out.push({
        ...base,
        rule: soon ? 'kv-expires-7d' : 'kv-expires-30d',
        severity: soon ? 'high' : 'medium',
        title: `${cert ? 'Certificate' : 'Secret'} expires within ${soon ? LIMITS.week : LIMITS.month} days`,
        why: `${item.name} expires in ${plural(n, 'day')} (${String(item.expires).slice(0, 10)}).${readers}`,
        fix: cert ? `Renew it before then: az keyvault certificate create --vault-name ${vname} -n ${item.name} -p "$(az keyvault certificate get-policy --vault-name ${vname} -n ${item.name})"` : `Rotate it before then (/rotate ${item.name}) and set the new version's expiry.`,
      });
    }
    // Rotation: a certificate's renewal is its expiry; a secret's age is when it last changed.
    if (cert) continue;
    const changed = Date.parse(item.updated ?? item.created ?? '');
    if (!Number.isFinite(changed)) continue;
    const age = Math.floor((now - changed) / DAY);
    if (age > LIMITS.aging)
      out.push({ ...base, rule: age > LIMITS.stale ? 'kv-stale-365d' : 'kv-stale-180d', severity: age > LIMITS.stale ? 'medium' : 'low', title: `Secret not rotated in over ${age > LIMITS.stale ? LIMITS.stale : LIMITS.aging} days`, why: `${item.name} last changed ${plural(age, 'day')} ago: whoever saw it since then still knows it.${readers}`, fix: `Rotate it: /rotate ${item.name} (a new value, the apps restarted, the old version disabled).` });
  }
  return out;
}

/**
 * The vault itself, lightly (Sonar looks at a vault's posture in depth): purge protection off, and a
 * public network endpoint with no rules. Only what ARM said: an unknown setting is no finding.
 */
export function vaultPostureFindings(vault) {
  const p = vault?.posture;
  if (!p) return [];
  const out = [];
  const base = { where: vault.name, scope: 'vault', vault: vault.name, kind: 'config' };
  if (p.purgeProtection === false)
    out.push({ ...base, rule: 'kv-purge-protection-off', severity: 'medium', title: 'Purge protection off', why: `A secret deleted from ${vault.name}, or the vault itself, can be purged at once, by mistake or on purpose, with no way back.`, fix: `az keyvault update --name ${vault.name} --enable-purge-protection true (it can't be turned off again).` });
  if (p.publicNetworkAccess !== 'Disabled' && p.defaultAction === 'Allow' && !p.rules)
    out.push({ ...base, rule: 'kv-public-network', severity: 'low', title: 'Vault open to every network', why: `${vault.name} takes requests from any address; only its access policies or roles stand in the way.`, fix: `Allow only your networks: az keyvault network-rule add --name ${vault.name} --ip-address <your range>, then az keyvault update --name ${vault.name} --default-action Deny (or a private endpoint).` });
  return out;
}

// ——— App Service settings ———

/** The az command that sets an app's setting or connection string to a Key Vault reference, as text (never run). */
export function referenceFix(site, key, { vault } = {}) {
  const kv = vault ?? '<vault>';
  const secret = vaultName(key.replace(/^ConnectionStrings:/i, 'ConnectionStrings--'));
  const ref = `@Microsoft.KeyVault(VaultName=${kv};SecretName=${secret})`;
  const where = `-g ${site.resourceGroup} -n ${site.name}${site.slot ? ` --slot ${site.slot}` : ''}`;
  const cli = site.kind === 'function' ? 'functionapp' : 'webapp';
  const set = /^ConnectionStrings:/i.test(key)
    ? `az webapp config connection-string set ${where} --connection-string-type ${site.connectionType ?? 'Custom'} --settings "${key.slice('ConnectionStrings:'.length)}=${ref}"`
    : `az ${cli} config appsettings set ${where} --settings "${key}=${ref}"`;
  return `Put the value in Key Vault (az keyvault secret set --vault-name ${kv} --name ${secret} --file <a file holding it>), then refer to it: ${set}. The app's managed identity needs to read the vault's secrets; rotate the value, as it has been readable in the app's configuration.`;
}

/**
 * An app's (and its slots') settings and connection strings judged by their shape, never shown: a
 * secret held as plain text rather than a Key Vault reference (high), and a setting one slot reads from
 * the vault while another holds it as plain text (medium). `sites` are [{ site, settings, strings }].
 */
export function settingFindings(sites = [], { vault } = {}) {
  const out = [];
  for (const { site, settings = {}, strings = {} } of sites) {
    const all = [...Object.entries(settings).map(([k, v]) => [k, v, null]), ...Object.entries(strings).map(([k, s]) => [`ConnectionStrings:${k}`, s?.value, s?.type])];
    for (const [key, value, type] of all) {
      const hit = plainSecret(key, value);
      if (!hit) continue;
      out.push({
        rule: 'plain-secret-setting',
        severity: 'high',
        kind: 'secret',
        scope: 'app',
        site: siteLabel(site),
        key,
        title: hit.shape ? `${hit.shape.title} in a plain ${type ? 'connection string' : 'setting'}` : `Secret in a plain ${type ? 'connection string' : 'setting'}`,
        where: `${siteLabel(site)}/${key}`,
        why: `${key} holds ${hit.shape ? `a ${hit.shape.title.toLowerCase()}` : 'what its name says is a secret'} as plain text, not a Key Vault reference: anyone who may read ${siteLabel(site)}'s configuration reads it, and it isn't rotated or audited with the vault's.`,
        fix: referenceFix({ ...site, connectionType: type }, key, { vault }),
        excerpt: hit.excerpt,
      });
    }
  }
  // The slots of one app, side by side: a setting a reference in one and plain text in another.
  const apps = new Map();
  for (const s of sites) {
    const id = `${s.site.resourceGroup}/${s.site.name}`.toLowerCase();
    apps.set(id, [...(apps.get(id) ?? []), s]);
  }
  for (const members of apps.values()) {
    if (members.length < 2) continue;
    const keys = new Map();
    for (const m of members) {
      const all = [...Object.entries(m.settings ?? {}), ...Object.entries(m.strings ?? {}).map(([k, s]) => [`ConnectionStrings:${k}`, s?.value])];
      for (const [key, value] of all) {
        const norm = normKey(key);
        if (!keys.has(norm)) keys.set(norm, []);
        keys.get(norm).push({ m, key, value });
      }
    }
    for (const holders of keys.values()) {
      const refs = holders.filter((h) => isReference(h.value));
      const plain = holders.filter((h) => !isReference(h.value) && isLiteral(h.value));
      if (!refs.length || !plain.length) continue;
      for (const h of plain) {
        out.push({
          rule: 'slot-reference-mismatch',
          severity: 'medium',
          kind: 'config',
          scope: 'app',
          site: siteLabel(h.m.site),
          key: h.key,
          title: 'Key Vault reference in one slot, plain text in another',
          where: `${siteLabel(h.m.site)}/${h.key}`,
          why: `${refs.map((r) => siteLabel(r.m.site)).join(', ')} ${refs.length === 1 ? 'reads' : 'read'} ${h.key} from Key Vault; ${siteLabel(h.m.site)} holds it as plain text, and a swap carries whichever is in the slot.`,
          fix: referenceFix(h.m.site, h.key, { vault: parseReference(refs[0].value)?.vault ?? vault }),
        });
      }
    }
  }
  return out;
}

// ——— The folder ———

/** Whether a local source's values are only examples (.env.example, .env.sample …): never judged. */
const isExampleSource = (s) => Boolean(s.example) || /\.(example|sample|template|dist)$/i.test(String(s.label ?? ''));

/** The line of a flattened JSON key in its file's text: the first line naming its last part, from its section's on. */
export function jsonKeyLine(text, key) {
  const parts = String(key).split(':').filter((p) => !/^\d+$/.test(p));
  const lines = String(text ?? '').split(/\r?\n/);
  let from = 0;
  for (const p of parts) {
    const re = new RegExp(`"${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*:`, 'i');
    const at = lines.findIndex((l, i) => i >= from && re.test(l));
    if (at < 0) return null;
    from = at;
  }
  return parts.length ? from + 1 : null;
}

/**
 * The folder's files that git tracks, read for secrets: a value named or shaped like a secret in a
 * tracked .env or appsettings file is in the repository and its history (high). User secrets, and
 * files git doesn't track, are where secrets belong: no finding. `tracked(source)` says whether git
 * tracks a source's file (a null `tracked` means it isn't known: no finding either); `rel(file)` its
 * path from the folder.
 */
export function localFindings(sources = [], { tracked = null, rel = (f) => f } = {}) {
  if (!tracked) return [];
  const out = [];
  for (const s of sources) {
    if (!['env', 'appsettings', 'http'].includes(s.kind) || isExampleSource(s) || !tracked(s)) continue;
    const path = rel(s.file);
    for (const e of s.entries ?? []) {
      const hit = plainSecret(e.key, e.value);
      if (!hit) continue;
      out.push({
        rule: 'secret-in-git',
        severity: 'high',
        kind: 'secret',
        scope: 'file',
        key: e.key,
        source: s.id,
        title: hit.shape ? `${hit.shape.title} in a file git tracks` : 'Secret in a file git tracks',
        where: path,
        ...(e.line ? { line: e.line } : {}),
        why: `${e.key} in ${path} is committed with the repository: everyone who can clone it, and its history, has the value.`,
        fix: s.kind === 'env'
          ? `Take ${path} out of git (git rm --cached ${path}, and .env* in .gitignore) and rotate the value: the history keeps it.`
          : s.kind === 'http'
            ? `Move it to http-client.private.env.json, which git should ignore, and rotate it.`
            : `Move it to user secrets (dotnet user-secrets set "${e.key}" <value>) or the environment, leave the key empty in ${path}, and rotate it: the history keeps it.`,
        excerpt: hit.excerpt,
      });
    }
  }
  return out;
}

// ——— The same secret in two environments ———

/** An environment's name as one word: development, staging, test, production, or the name as given. */
export function normEnv(name) {
  const n = String(name ?? '').trim().toLowerCase();
  if (!n) return null;
  if (/^(dev|develop|development|local|localhost)$/.test(n)) return 'development';
  if (/^(prod|production|prd|live)$/.test(n)) return 'production';
  if (/^(stage|staging|stg|uat|preprod|pre-prod|preproduction)$/.test(n)) return 'staging';
  if (/^(test|testing|qa|ci)$/.test(n)) return 'test';
  return n;
}

/**
 * The environment a local source's values are for: .env and .env.local, user secrets → development;
 * .env.<name>, appsettings.<Name>.json, Hail's <name> → that one; appsettings.json (every
 * environment's defaults) → null, not compared.
 */
export function envOfSource(s) {
  const lab = String(s?.label ?? '');
  if (s?.kind === 'usersecrets') return 'development';
  if (s?.kind === 'env') {
    const m = /^\.env(?:\.(.+))?$/.exec(lab);
    if (!m) return null;
    return m[1] ? normEnv(m[1]) : 'development';
  }
  if (s?.kind === 'appsettings') {
    const m = /^appsettings\.(.+)\.json$/i.exec(lab);
    return m ? normEnv(m[1]) : null;
  }
  if (s?.kind === 'http') return normEnv(lab.split(':').pop());
  return null;
}

/** The environment an App Service app or slot runs: production for the app itself, the slot's name otherwise. */
export const envOfSite = (site) => (site?.slot ? normEnv(site.slot) : 'production');

/**
 * The secrets two environments share: `holders` are [{ env, where, line?, key, hash, scope }], one
 * per secret value held in plain text, `hash` drift.js's keyed fingerprint of it (the value never
 * comes here). A hash held in two environments or more is one finding: medium when production is one
 * of them, low otherwise. `where` is production's holder when there is one.
 */
export function sharedSecretFindings(holders = []) {
  const groups = new Map();
  for (const h of holders) {
    if (!h.env || !h.hash) continue;
    groups.set(h.hash, [...(groups.get(h.hash) ?? []), h]);
  }
  const out = [];
  for (const list of groups.values()) {
    const envs = [...new Set(list.map((h) => h.env))].sort();
    if (envs.length < 2) continue;
    const prod = envs.includes('production');
    const first = list.find((h) => h.env === 'production') ?? list[0];
    const place = (h) => `${h.where}${h.line ? `:${h.line}` : ''}${h.key && !String(h.where).endsWith(h.key) ? ` (${h.key})` : ''}`;
    out.push({
      rule: 'shared-across-environments',
      severity: prod ? 'medium' : 'low',
      kind: 'secret',
      scope: first.scope,
      key: first.key,
      title: `The same secret in ${envs.join(' and ')}`,
      where: first.where,
      ...(first.line ? { line: first.line } : {}),
      why: `One value, compared by a hash and never shown, is held in ${envs.join(' and ')}: ${list.map((h) => `${place(h)} (${h.env})`).join(', ')}. Whoever has the ${prod ? 'development' : 'other'} copy has ${prod ? 'production' : 'this one'}.`,
      fix: `Give each environment a value of its own: a new one for ${prod ? 'production' : envs[envs.length - 1]} (kept in Key Vault), and rotate it where it is used.`,
      places: list.map((h) => ({ where: h.where, line: h.line, key: h.key, env: h.env })),
    });
  }
  return out;
}

/**
 * Every hygiene finding, worst first, from what was read (security.js's readHygiene): { vaults: [{
 * vault, secrets, certificates }], sites: [{ site, settings, strings }], local: sources, tracked,
 * rel, holders (sharedSecretFindings'), vault (the vault named in a fix) }.
 */
export function hygieneFindings(read, { now = Date.now() } = {}) {
  const use = vaultUse(read.sites ?? []);
  return sortFindings([
    ...(read.vaults ?? []).flatMap((v) => [...vaultPostureFindings(v.vault), ...vaultItemFindings(v, { use, now })]),
    ...settingFindings(read.sites ?? [], { vault: read.vault }),
    ...localFindings(read.local ?? [], { tracked: read.tracked, rel: read.rel }),
    ...sharedSecretFindings(read.holders ?? []),
  ]);
}

/** The values the sources hold in plain text that are secrets (named or shaped so), as sharedSecretFindings takes them, hashed by `hash`. */
export function secretHolders({ local = [], sites = [], rel = (f) => f, hash }) {
  const out = [];
  for (const s of local) {
    if (isExampleSource(s)) continue;
    const env = envOfSource(s);
    if (!env) continue;
    for (const e of s.entries ?? []) if (plainSecret(e.key, e.value)) out.push({ env, where: rel(s.file), line: e.line, key: e.key, hash: hash(String(e.value).trim()), scope: s.kind === 'usersecrets' ? 'local' : 'file' });
  }
  for (const { site, settings = {}, strings = {} } of sites) {
    const env = envOfSite(site);
    const all = [...Object.entries(settings), ...Object.entries(strings).map(([k, s]) => [`ConnectionStrings:${k}`, s?.value])];
    for (const [key, value] of all) if (plainSecret(key, value)) out.push({ env, where: `${siteLabel(site)}/${key}`, key, hash: hash(String(value).trim()), scope: 'app' });
  }
  return out;
}
