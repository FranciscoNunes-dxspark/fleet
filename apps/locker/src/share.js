// What Locker hands its siblings and takes from them (family.js has the rest: the names, who takes what,
// the paste rule and the copied note). Never a value: an app is handed over by its name, and a sibling
// reads what it needs from Azure itself. Pure.
import { relative } from 'node:path';
import { shareLine, trawlLine } from '@fleet/kit/family.js';
import { label } from './azure/arm.js';

/**
 * /family: what the project in `p` (family.js projectAt) offers the siblings, as lines for their prompts:
 * [{ app, line, what }]. Splice opens the checkout, Bosun runs the project, Hail opens each .http file,
 * Trawl each database its settings name (never with its password); Sonar the App Service app Locker
 * is looking at.
 */
export function familyChoices(p, { target } = {}) {
  const out = [];
  if (p.repo) out.push({ app: 'splice', line: shareLine('open', [p.repo]), what: `the checkout ${p.repo}` });
  if (p.crew) out.push({ app: 'bosun', line: shareLine('move', [p.dir]), what: `run ${p.dir}` });
  for (const f of p.httpFiles ?? []) out.push({ app: 'hail', line: shareLine('open', [f]), what: relative(p.dir, f).replace(/\\/g, '/') });
  for (const d of p.databases ?? []) out.push({ app: 'trawl', line: trawlLine(d, d.name), what: `${d.name} from ${d.source}: ${d.server}${d.database ? `/${d.database}` : ''}` });
  if (target) out.push({ app: 'sonar', line: sonarLine(target), what: `${label(target)}'s settings, logs and problems` });
  return out;
}

/** The line for Sonar's prompt that opens an app's or slot's settings there: /appsettings shop-api/staging. */
export const sonarLine = (target) => shareLine('appsettings', [label(target)]);

/** An app or slot as a `site` context's data: { name, slot?, resourceGroup?, subscription?, id? }. */
export function siteData(target, subscription) {
  return { name: target.name, ...(target.slot ? { slot: target.slot } : {}), ...(target.resourceGroup ? { resourceGroup: target.resourceGroup } : {}), ...(subscription ? { subscription } : {}), ...(target.id ? { id: target.id } : {}) };
}

/**
 * The app or slot of `sites` a `site` context names: by its id, else by its name and slot (and resource
 * group, when two apps share a name), ignoring case; null when none is.
 */
export function siteIn(sites, data) {
  const lower = (s) => String(s ?? '').toLowerCase();
  if (data?.id) {
    const byId = sites.find((s) => lower(s.id) === lower(data.id));
    if (byId) return byId;
  }
  const named = sites.filter((s) => lower(s.name) === lower(data?.name) && lower(s.slot) === lower(data?.slot));
  return (data?.resourceGroup ? named.find((s) => lower(s.resourceGroup) === lower(data.resourceGroup)) : null) ?? named[0] ?? null;
}

/** The app or slot a name typed after /app means: app, app/slot, exactly, else the only one it starts. */
export function siteNamed(sites, text) {
  const n = String(text ?? '').trim().toLowerCase();
  if (!n) return null;
  const exact = sites.find((s) => label(s).toLowerCase() === n);
  if (exact) return exact;
  const starts = sites.filter((s) => label(s).toLowerCase().startsWith(n));
  return starts.length === 1 ? starts[0] : null;
}
