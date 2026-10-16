// Several Azure DevOps organizations: lists carry an `org` key on each entry.
// Work item numbers are only unique within an organization, so calls by
// number say which one (the server uses the primary when it isn't given).
import { useApp } from './context.js';

const q = (org) => (org ? `?org=${encodeURIComponent(org)}` : '');
export const wiPath = (id, org) => `/workitems/${id}${q(org)}`;
export const wiActionsPath = (id, org) => `/workitems/${id}/actions${q(org)}`;
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
