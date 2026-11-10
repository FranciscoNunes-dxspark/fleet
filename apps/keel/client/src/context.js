import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api } from './api.js';

export const AppContext = createContext(null);
export const useApp = () => useContext(AppContext);

// Requests in flight, by path and refresh: two parts of the page asking for the same thing at the
// same time (the frame and the page both want /attention) share one request.
const inflight = new Map();
// Each path's last answer, so a page you come back to draws at once and then refreshes; bounded,
// oldest out first.
const lastData = new Map();
const LAST_MAX = 60;

function fetchShared(path, generation) {
  const key = `${generation}|${path}`;
  let p = inflight.get(key);
  if (!p) {
    p = api(path).finally(() => setTimeout(() => inflight.get(key) === p && inflight.delete(key), 1000));
    inflight.set(key, p);
  }
  return p;
}

function remember(path, data) {
  lastData.delete(path);
  lastData.set(path, data);
  if (lastData.size > LAST_MAX) lastData.delete(lastData.keys().next().value);
}

/** Forgets every remembered answer (signing out, switching organization). */
export function forgetApiCache() {
  lastData.clear();
  inflight.clear();
}

/**
 * Fetches `path` and re-fetches whenever the app-wide refresh key changes
 * (after any write, the refresh button, or the auto-refresh timer).
 * Keeps showing the previous data while reloading so tables don't flash, and starts from the
 * path's last answer when there is one, so going back to a page shows it at once.
 */
export function useApi(path) {
  const { refreshKey } = useApp();
  const [state, setState] = useState(() => ({ data: (path && lastData.get(path)) ?? null, error: null, loading: true }));
  const [localKey, setLocalKey] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    if (!path) return undefined;
    const mine = ++seq.current;
    setState((s) => ({ ...s, data: lastData.get(path) ?? s.data, loading: true }));
    // A reload asked for by this component (localKey) always goes to the server.
    const request = localKey ? api(path) : fetchShared(path, refreshKey);
    request
      .then((data) => { remember(path, data); if (mine === seq.current) setState({ data, error: null, loading: false }); })
      .catch((error) => mine === seq.current && setState((s) => ({ data: s.data, error, loading: false })));
    return undefined;
  }, [path, refreshKey, localKey]);

  const reload = useCallback(() => setLocalKey((k) => k + 1), []);
  return { ...state, reload };
}
