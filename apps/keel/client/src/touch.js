// What makes Keel behave like an app on a phone rather than a web page: the back gesture (or
// Android's back button) closes the panel or menu that's open instead of leaving the page, and
// pulling down at the top of a page refreshes it.
import { useEffect, useRef, useState } from 'react';

const touchScreen = () => typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;

// A step taken out after a layer closed waits a moment, so a layer opening straight after (the
// search choosing a pull request opens its panel) takes the step over instead of being closed
// by it.
let stepOut = null;

/**
 * While `open`, a step in the browser's history that going back takes away, closing it with
 * `onClose`. Touch screens only: on a computer the back button keeps meaning the page before.
 */
export function useBackCloses(open, onClose) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open || !touchScreen()) return undefined;
    // The same URL and the router's own state, so React Router sees nothing change either way.
    const mark = Math.random().toString(36).slice(2);
    const state = { ...window.history.state, keelLayer: mark };
    if (stepOut) {
      clearTimeout(stepOut);
      stepOut = null;
      window.history.replaceState(state, '');
    } else {
      window.history.pushState(state, '');
    }
    let popped = false;
    // Back from a layer opened over this one lands on this one's step: it stays open.
    const onPop = () => {
      if (window.history.state?.keelLayer === mark) return;
      popped = true;
      closeRef.current();
    };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      // Closed some other way (the ✕, a tap outside): take the step back out, unless a link in
      // the panel has already moved on to another page.
      if (popped || window.history.state?.keelLayer !== mark) return;
      stepOut = setTimeout(() => {
        stepOut = null;
        if (window.history.state?.keelLayer === mark) window.history.back();
      }, 0);
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
