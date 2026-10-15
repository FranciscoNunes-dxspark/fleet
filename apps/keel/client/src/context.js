import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api } from './api.js';

export const AppContext = createContext(null);
export const useApp = () => useContext(AppContext);

/**
 * Fetches `path` and re-fetches whenever the app-wide refresh key changes
 * (after any write, the refresh button, or the auto-refresh timer).
 * Keeps showing the previous data while reloading so tables don't flash.
 */
export function useApi(path) {
  const { refreshKey } = useApp();
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const [localKey, setLocalKey] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    if (!path) return undefined;
    const mine = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    api(path)
      .then((data) => mine === seq.current && setState({ data, error: null, loading: false }))
      .catch((error) => mine === seq.current && setState((s) => ({ data: s.data, error, loading: false })));
    return undefined;
  }, [path, refreshKey, localKey]);

  const reload = useCallback(() => setLocalKey((k) => k + 1), []);
  return { ...state, reload };
}
