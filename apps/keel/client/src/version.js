// "A new version of Keel is available": each build has its own id (vite.config.js), baked into the page
// (__KEEL_BUILD__) and served by the server as /build.json. An open Keel checks now and then, and offers
// to reload when the server has moved on. The service worker fetches the page fresh, so a reload is enough.
import { useEffect, useState } from 'react';

const EVERY = 10 * 60_000;

/** True once the server runs a newer build than this page. */
export function useNewVersion() {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    if (!import.meta.env.PROD) return undefined; // the dev server reloads by itself
    let stopped = false;
    const check = async () => {
      try {
        const res = await fetch('/build.json', { cache: 'no-store' });
        if (!res.ok) return;
        const { build } = await res.json();
        if (!stopped && build && build !== __KEEL_BUILD__) setAvailable(true);
      } catch {
        // offline, or the server is restarting: try again later
      }
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') check();
    };
    check();
    const timer = setInterval(check, EVERY);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
  return available;
}

/** Reload into the new version (and let the service worker pick up a new sw.js, if there is one). */
export async function updateNow() {
  try {
    await (await navigator.serviceWorker?.getRegistration())?.update();
  } catch {
    // no service worker here
  }
  window.location.reload();
}
