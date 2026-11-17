// Which images in a pull request's or work item's text Keel shows, and from where (markdown.jsx).
// Text comes from other people, so an image is never fetched from just anywhere: one hosted in
// your Azure DevOps organization loads through Keel's server (it needs your token), and one
// written into the text itself as a data: address (a screenshot pasted into a ticket, often)
// is shown as it is, since showing it reaches nothing outside. Anything else is left out.

// Raster images only: an SVG is a document of its own, and not worth the doubt.
const DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp|bmp|avif|x-icon|vnd\.microsoft\.icon);base64,[a-z0-9+/=\s]+$/i;

/**
 * Where an image's `src` should load from, or null to leave it out: the data: address itself,
 * Keel's image proxy for one in an organization (`orgPrefixes`, each ending in "/"; relative
 * addresses are the first one's), or nothing.
 */
export function imageSource(src, orgPrefixes) {
  const raw = String(src || '').trim();
  if (!raw) return null;
  if (/^data:/i.test(raw)) return DATA_IMAGE.test(raw) ? raw.replace(/\s+/g, '') : null;
  if (!orgPrefixes.length) return null;
  let abs;
  try {
    abs = new URL(raw, orgPrefixes[0]).href;
  } catch {
    return null;
  }
  return orgPrefixes.some((prefix) => abs.toLowerCase().startsWith(prefix.toLowerCase())) ? `/api/image?url=${encodeURIComponent(abs)}` : null;
}
