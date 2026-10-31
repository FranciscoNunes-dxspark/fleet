// What the views draw, and finding a change by what's typed. Pure.
import { theme } from './theme.js';
import { ordered } from './plan.js';

export const ACTION_MARK = { create: '+', update: '~', deploy: '~', replace: '±', delete: '-', forget: '⊘', read: '≡', noop: '·', ignore: '·', unsupported: '?' };
export const ACTION_WORD = { create: 'create', update: 'update', deploy: 'deploy', replace: 'replace', delete: 'destroy', forget: 'forget', read: 'read', noop: 'no change', ignore: 'ignored', unsupported: 'unsupported' };

/** The colour an action is drawn in (read while drawing, from the theme). */
export const actionTone = (a) => ({ create: theme.add, update: theme.warn, deploy: theme.warn, replace: theme.del, delete: theme.del, forget: theme.warn, unsupported: theme.info })[a] ?? theme.dim;

/** The changes the Changes view lists: what does something, worst first; with `all`, the unchanged ones too. */
export const changeRows = (changes, { all = false } = {}) => ordered(all ? changes : changes.filter((c) => !['noop', 'ignore'].includes(c.action)));

/** A state's resources by module, the root's first: rows of { heading } or { resource }. */
export function stateRows(resources) {
  const groups = new Map();
  for (const r of resources) {
    const key = r.module ?? '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const out = [];
  for (const key of [...groups.keys()].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))) {
    out.push({ heading: key || 'root module', count: groups.get(key).length });
    for (const r of groups.get(key).sort((a, b) => a.address.localeCompare(b.address))) out.push({ resource: r });
  }
  return out;
}

/** The change `text` names: its address, or the start of one; null when none or several. */
export function findChange(changes, text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  const exact = changes.find((c) => c.address === t);
  if (exact) return exact;
  const starts = changes.filter((c) => c.address.startsWith(t) || c.address.endsWith(`.${t}`) || c.address.endsWith(`/${t}`));
  return starts.length === 1 ? starts[0] : null;
}

const WEB_APPS = /^azurerm_(linux_|windows_)?(web|function)_app$|^azurerm_app_service$|^azurerm_function_app$/;

/** The App Service app a change is, as the family's `site` context ({ name, slot?, resourceGroup?, subscription?, id? }), or null. */
export function siteOf(change) {
  if (WEB_APPS.test(change.type ?? '')) {
    const name = change.diff.find((d) => d.path === 'name')?.after ?? change.name;
    return { name: typeof name === 'string' && !name.startsWith('(') ? name : change.name, ...(change.resourceGroup ? { resourceGroup: change.resourceGroup } : {}), ...(change.id ? { id: change.id } : {}) };
  }
  if (/^Microsoft\.Web\/sites(\/slots)?$/i.test(change.type ?? '')) {
    const [name, slot] = change.name.split('/');
    return { name, ...(slot ? { slot } : {}), ...(change.resourceGroup ? { resourceGroup: change.resourceGroup } : {}), ...(change.subscription ? { subscription: change.subscription } : {}), id: change.id };
  }
  return null;
}
