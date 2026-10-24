// A storage account's blobs, through Blob Storage's own API with an Entra token (azure/arm.js
// containers, blobs, readBlob; demo.js too): containers, then blobs a folder at a time (the "/" in
// their names), and a small one's text. Reading only. Pure: Storage's XML, read with regexes (it's
// machine-written and flat), addresses, sizes.

/** Storage's own API version, sent with every call. */
export const STORAGE_VERSION = '2023-11-03';

/** The most of a blob the viewer shows: 1 MB. */
export const VIEW_MAX = 1024 * 1024;

const decode = (s) =>
  String(s ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
const tag = (xml, name) => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? decode(m[1]) : null;
};
const each = (xml, name) => [...String(xml ?? '').matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'g'))].map((m) => m[1]);
const iso = (http) => (http && !Number.isNaN(Date.parse(http)) ? new Date(http).toISOString() : null);

/** List Containers' answer: { containers: [{ name, modified, access }], next } (next: the marker for the page after). */
export function parseContainers(xml) {
  const containers = each(xml, 'Container').map((c) => ({ name: tag(c, 'Name'), modified: iso(tag(c, 'Last-Modified')), access: tag(c, 'PublicAccess') ?? 'private' }));
  return { containers, next: tag(xml, 'NextMarker') || null };
}

/**
 * List Blobs' answer, asked with delimiter "/": { prefixes: ['folder/'], blobs: [{ name, size, modified,
 * type, tier, kind }], next }.
 */
export function parseBlobs(xml) {
  const prefixes = each(xml, 'BlobPrefix').map((p) => tag(p, 'Name'));
  const blobs = each(xml, 'Blob').map((b) => ({
    name: tag(b, 'Name'),
    size: Number(tag(b, 'Content-Length') ?? 0),
    modified: iso(tag(b, 'Last-Modified')),
    type: tag(b, 'Content-Type') ?? '',
    tier: tag(b, 'AccessTier') ?? '',
    kind: tag(b, 'BlobType') ?? '',
  }));
  return { prefixes, blobs, next: tag(xml, 'NextMarker') || null };
}

/** A blob's address: each part of its name encoded, the slashes kept. */
export const blobUrl = (account, container, name = '') => `https://${account.host}/${encodeURIComponent(container)}${name ? `/${String(name).split('/').map(encodeURIComponent).join('/')}` : ''}`;

/** Whether a blob is text the viewer can show, by its type or its name. */
export const isText = (blob) => /^text\/|json|xml|yaml|csv|javascript|x-sh|svg/i.test(blob.type ?? '') || /\.(txt|log|json|jsonl|ndjson|csv|tsv|xml|ya?ml|md|html?|css|js|mjs|ts|sql|ini|conf|cfg|env|properties|sh|ps1|bicep|tf)$/i.test(blob.name ?? '');

/** A size in words: 512 B, 3.4 KB, 12 MB. */
export function sizeText(n) {
  const b = Number(n ?? 0);
  if (b < 1024) return `${b} B`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(b < 10 * 1024 ? 1 : 0)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(b < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(b / 1024 ** 3).toFixed(1)} GB`;
}

/** The last part of a name under `prefix`: "2026/10/report.csv" under "2026/" is "10/report.csv"… as a folder, "10/". */
export const shortName = (name, prefix = '') => (String(name).startsWith(prefix) ? String(name).slice(prefix.length) : String(name));

/** What a 403 from Blob Storage means, in words: the data role it takes, which Owner and Contributor don't give. */
export const storageRoleNeeded = (account, what) => `Storage Blob Data Reader on ${account.name} is needed to read its blobs (${what}); Owner or Contributor on the account isn't enough with a sign-in`;
