import { t, tx } from './i18n.js';

/** A File or Blob body is sent as is (an upload); anything else as JSON. */
export async function api(path, { method = 'GET', body } = {}) {
  const raw = body instanceof Blob;
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      'x-keel': '1',
      ...(body !== undefined ? { 'Content-Type': raw ? 'application/octet-stream' : 'application/json' } : {}),
    },
    body: body === undefined || raw ? body : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    // Session ended or Azure DevOps rejected the token: ask the app to show sign-in.
    if (res.status === 401 && data?.code === 'signin-required') {
      window.dispatchEvent(new CustomEvent('keel:signed-out', { detail: { reason: data.code, message: data.error } }));
    }
    // Signed in, but no working Azure DevOps token: ask the person to connect one.
    if (data?.code === 'token-required' || data?.code === 'token-rejected') {
      window.dispatchEvent(new CustomEvent('keel:token-required', { detail: { reason: data.code, message: data.error } }));
    }
    // Server messages are English; shown in the chosen language when translated.
    throw Object.assign(new Error(data?.error ? tx(data.error) : t('Request failed ({status})', { status: res.status })), { status: res.status, code: data?.code });
  }
  return data;
}

export const prPath = (t) => `/prs/${encodeURIComponent(t.projectId)}/${encodeURIComponent(t.repoId)}/${t.id}`;
