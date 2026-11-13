// What makes Keel behave like an app rather than a web page: going back (the browser's button,
// Android's back button or gesture) closes the pane that's open instead of leaving the page, and
// on a phone pulling down at the top of a page refreshes it.
import { useEffect, useRef, useState } from 'react';

const touchScreen = () => typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;

// The panes open over the page, oldest first. Each has a step in the browser's history with
// its depth on it (`keelDepth`), so going back lands on the pane under it, or on the page.
const layers = [];
let settling = null;
const depthNow = () => window.history.state?.keelDepth || 0;

// After panes close some other way (✕, Escape, a tap outside), their steps come back out, all
// at once and a moment later, so a pane opening straight after (search choosing a pull request
// opens its panel) takes a step over instead of having it taken away under it.
function settle() {
  settling = null;
  const extra = depthNow() - layers.length;
  if (extra > 0) window.history.go(-extra);
}

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', () => {
    // Back (or forward) to a depth: every pane above it closes, the newest first.
    const depth = depthNow();
    while (layers.length > depth) layers.pop().close();
  });
}

/**
 * While `open`, a pane over the page: going back (the browser's button, Android's back
 * gesture) closes it with `onClose` rather than leaving the page under it.
 */
export function useBackCloses(open, onClose) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open || typeof window === 'undefined') return undefined;
    const layer = { close: () => closeRef.current() };
    const depth = layers.length + 1;
    // The same URL and the router's own state, so React Router sees nothing change either way.
    const state = { ...window.history.state, keelDepth: depth };
    if (settling && depthNow() >= depth) {
      clearTimeout(settling);
      settling = null;
      window.history.replaceState(state, '');
    } else {
      window.history.pushState(state, '');
    }
    layers.push(layer);
    return () => {
      const at = layers.indexOf(layer);
      if (at < 0) return; // closed by going back: its step has gone already
      layers.splice(at, 1);
      // Its step comes out, unless a link in the pane has moved on to another page.
      if (depthNow() > layers.length && !settling) settling = setTimeout(settle, 0);
    };
  }, [open]);
}

// The finger travels PULL_AT before the indicator has gone far enough (PULL_READY on screen)
// for letting go to refresh.
const PULL_AT = 64;
const PULL_MAX = 96;
/** How far the indicator has to come down before letting go refreshes, in pixels. */
export const PULL_READY = PULL_AT * 0.6;

/** The distance a finger's `dy` moves the indicator: one to one at first, then resisting. */
export function pullDistance(dy) {
  if (dy <= 0) return 0;
  return Math.min(PULL_MAX, dy < PULL_AT ? dy * 0.6 : PULL_AT * 0.6 + (dy - PULL_AT) * 0.3);
}

// A pull starts only where the page is already at its top: not inside a panel, a menu or a
// pane that has been scrolled down.
const scrolledInside = (el) => {
  for (let n = el; n && n !== document.body; n = n.parentElement) {
    if (n.scrollTop > 0) return true;
    if (n.matches?.('.drawer-layer, [role="dialog"], [data-radix-popper-content-wrapper], .line-menu-pop, input, textarea, select')) return true;
  }
  return false;
};

/**
 * Pull down at the top of the page to call `onRefresh`. Returns the pull's distance (0 when
 * none), for the indicator to follow the finger.
 */
export function usePullToRefresh(onRefresh, enabled) {
  const [pull, setPull] = useState(0);
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;
  useEffect(() => {
    if (!enabled || !touchScreen()) return undefined;
    let start = null;
    let dist = 0;
    const down = (e) => {
      start = e.touches.length === 1 && window.scrollY <= 0 && !scrolledInside(e.target) ? e.touches[0].clientY : null;
      dist = 0;
    };
    const move = (e) => {
      if (start == null) return;
      if (window.scrollY > 0) { start = null; setPull(0); return; }
      const d = pullDistance(e.touches[0].clientY - start);
      // A little tick as the pull crosses the line, where the phone can.
      if ((d >= PULL_READY) !== (dist >= PULL_READY)) navigator.vibrate?.(8);
      dist = d;
      setPull(d);
    };
    const up = () => {
      if (start != null && dist >= PULL_READY) refreshRef.current();
      start = null;
      dist = 0;
      setPull(0);
    };
    window.addEventListener('touchstart', down, { passive: true });
    window.addEventListener('touchmove', move, { passive: true });
    window.addEventListener('touchend', up);
    window.addEventListener('touchcancel', up);
    return () => {
      window.removeEventListener('touchstart', down);
      window.removeEventListener('touchmove', move);
      window.removeEventListener('touchend', up);
      window.removeEventListener('touchcancel', up);
    };
  }, [enabled]);
  return pull;
}
