export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      'x-shipdeck': '1',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    // Session ended or Azure DevOps rejected the token: ask the app to show sign-in.
    if (res.status === 401 && data?.code === 'signin-required') {
      window.dispatchEvent(new CustomEvent('shipdeck:signed-out', { detail: { reason: data.code, message: data.error } }));
    }
    // Signed in, but no working Azure DevOps token: ask the person to connect one.
    if (data?.code === 'token-required' || data?.code === 'token-rejected') {
      window.dispatchEvent(new CustomEvent('shipdeck:token-required', { detail: { reason: data.code, message: data.error } }));
    }
    throw Object.assign(new Error(data?.error || `Request failed (${res.status})`), { status: res.status, code: data?.code });
  }
  return data;
}

export const prPath = (t) => `/prs/${encodeURIComponent(t.projectId)}/${encodeURIComponent(t.repoId)}/${t.id}`;
