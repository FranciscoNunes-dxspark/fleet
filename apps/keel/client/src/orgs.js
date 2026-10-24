// Several organizations (Azure DevOps, or GitHub owners): lists carry an `org` key on each entry.
// Work item numbers are only unique within an organization, so calls by
// number say which one (the server uses the primary when it isn't given).
import { useApp } from './context.js';

const q = (org) => (org ? `?org=${encodeURIComponent(org)}` : '');
export const wiPath = (id, org) => `/workitems/${id}${q(org)}`;
export const wiActionsPath = (id, org) => `/workitems/${id}/actions${q(org)}`;
/** Where a file is uploaded to attach it to a work item. */
export const attachUploadPath = (id, name, org) => `/workitems/${id}/attachments?${new URLSearchParams({ name, ...(org ? { org } : {}) })}`;
/** Download link for a work item attachment; inline shows an image in the browser. */
export const attachmentUrl = (id, a, org, inline = false) => {
  const params = new URLSearchParams({ ...(org ? { org } : {}), ...(inline ? { inline: '1' } : {}) }).toString();
  return `/api/workitems/${id}/attachments/${encodeURIComponent(a.id)}${params ? `?${params}` : ''}`;
};
export const approvalPath = (a) => `/approvals/${a.kind}/${encodeURIComponent(a.id)}${q(a.org)}`;

/** (key) → the organization's name when there are several, else null (nothing to tell apart). */
export function useOrgName() {
  const { meta } = useApp();
  const orgs = meta?.orgs || [];
  return (key) => (orgs.length > 1 ? orgs.find((o) => o.key === key)?.name || key : null);
}

/** "Org · Project" when there are several organizations, else just the project. */
export function useProjectLabel() {
  const orgName = useOrgName();
  return (projectName, org) => (orgName(org) ? `${orgName(org)} · ${projectName}` : projectName);
}

/** (key) → the organization's kind: 'github' for a GitHub owner, else 'azdo'. */
export function useOrgKind() {
  const { meta } = useApp();
  const orgs = meta?.orgs || [];
  return (key) => orgs.find((o) => o.key === key)?.kind || 'azdo';
}

/** (url) → where a link opens: "GitHub" for a GitHub owner's address, else "Azure DevOps". */
export function useSourceName() {
  const { meta } = useApp();
  const github = (meta?.orgs || []).filter((o) => o.kind === 'github').map((o) => o.url.toLowerCase());
  return (url) => {
    const u = String(url || '').toLowerCase();
    return github.some((g) => u.startsWith(`${g}/`)) || u.startsWith('https://github.com/') ? 'GitHub' : 'Azure DevOps';
  };
}
