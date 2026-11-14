// What makes Keel behave like an app rather than a web page: going back (the browser's button,
// Android's back button or gesture) closes the pane that's open instead of leaving the page; and
// on a phone, pulling down at the top of a page refreshes it, the top bar tucks away while the page
// scrolls down, and the details panel is swiped away to the right.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

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

/**
 * True while the page is being scrolled down past its top, false once it scrolls back up a
 * little or reaches the top: the phone's top bar tucks away to give the page the room.
 */
export function useTuckOnScroll(enabled, resetKey) {
  const [tucked, setTucked] = useState(false);
  useEffect(() => setTucked(false), [resetKey]);
  useEffect(() => {
    if (!enabled) { setTucked(false); return undefined; }
    let last = window.scrollY;
    let frame = 0;
    const check = () => {
      frame = 0;
      const y = window.scrollY;
      const dy = y - last;
      // A few pixels either way is a finger resting, not a direction.
      if (y < 80) setTucked(false);
      else if (dy > 8) setTucked(true);
      else if (dy < -8) setTucked(false);
      else return;
      last = y;
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(check); };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => { window.removeEventListener('scroll', onScroll); cancelAnimationFrame(frame); };
  }, [enabled]);
  return tucked;
}

/** How far right a swipe has to carry a panel, as a share of its width, before letting go closes it. */
export const SWIPE_CLOSE = 0.3;

/** Does a swipe that moved `dx` right, `dy` down in `ms` close a panel `width` wide? A flick does too. */
export function swipeCloses(dx, dy, ms, width) {
  if (dx <= 0 || Math.abs(dy) > dx) return false;
  return dx >= width * SWIPE_CLOSE || (dx > 40 && dx / Math.max(ms, 1) > 0.6);
}

// Something under the finger that scrolls sideways itself (a diff, a wide table, code) keeps the swipe.
const scrollsSideways = (el, stop) => {
  for (let n = el; n && n !== stop; n = n.parentElement) {
    if (n.scrollWidth > n.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(n).overflowX)) return true;
    if (n.matches?.('input, textarea, select, [contenteditable="true"]')) return true;
  }
  return false;
};

/**
 * A panel (`ref`) a finger drags right to close with `onClose`, as an app's sheets do: it follows
 * the finger, the backdrop fading with it, and springs back if let go short of closing.
 */
export function useSwipeToClose(ref, onClose, enabled) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!enabled || !touchScreen()) return undefined;
    // The panel can mount a render after this runs (Radix's portal), so it's found at each touch.
    let el = null;
    const scrim = () => el?.parentElement?.querySelector('.drawer-scrim');
    let from = null;
    let dragging = false;
    const paint = (dx, animate) => {
      el.style.transition = animate ? 'transform var(--dur-slow) ease-out' : 'none';
      el.style.transform = dx ? `translateX(${dx}px)` : '';
      const s = scrim();
      if (s) {
        s.style.transition = el.style.transition.replace('transform', 'opacity');
        s.style.opacity = dx ? String(Math.max(0, 1 - dx / el.offsetWidth)) : '';
      }
    };
    const down = (e) => {
      el = ref.current;
      from = el && el.contains(e.target) && e.touches.length === 1 && !scrollsSideways(e.target, el) ? { x: e.touches[0].clientX, y: e.touches[0].clientY, t: e.timeStamp } : null;
      dragging = false;
    };
    const move = (e) => {
      if (!from) return;
      const dx = e.touches[0].clientX - from.x;
      const dy = e.touches[0].clientY - from.y;
      if (!dragging) {
        // Decide once, after a few pixels: mostly sideways and rightwards is ours, anything else is a scroll.
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
        if (dx <= 0 || Math.abs(dy) > dx) { from = null; return; }
        dragging = true;
      }
      e.preventDefault();
      paint(Math.max(0, dx), false);
    };
    const up = (e) => {
      if (!from || !dragging) { from = null; return; }
      const touch = e.changedTouches[0];
      const dx = touch.clientX - from.x;
      const dy = touch.clientY - from.y;
      const ms = e.timeStamp - from.t;
      from = null;
      dragging = false;
      if (swipeCloses(dx, dy, ms, el.offsetWidth)) {
        paint(el.offsetWidth, true);
        setTimeout(() => closeRef.current(), 160);
      } else {
        paint(0, true);
      }
    };
    window.addEventListener('touchstart', down, { passive: true });
    window.addEventListener('touchmove', move, { passive: false });
    window.addEventListener('touchend', up);
    window.addEventListener('touchcancel', up);
    return () => {
      window.removeEventListener('touchstart', down);
      window.removeEventListener('touchmove', move);
      window.removeEventListener('touchend', up);
      window.removeEventListener('touchcancel', up);
    };
  }, [ref, enabled]);
}

/**
 * Each page's place, kept while Keel is open: `back()` before moving to another tab makes the
 * page it lands on open where you left it (or at its top, the first time), as an app's tabs do.
 * The page may still be loading, so it tries for a moment, and stops as soon as you touch it.
 */
export function useScrollMemory(key) {
  const places = useRef(new Map());
  const wanted = useRef(false);
  const keyRef = useRef(key);
  useEffect(() => {
    const onScroll = () => places.current.set(keyRef.current, window.scrollY);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  useLayoutEffect(() => {
    keyRef.current = key;
    if (!wanted.current) return undefined;
    wanted.current = false;
    const y = places.current.get(key) || 0;
    let timer = 0;
    const until = Date.now() + 2000;
    const stop = () => clearTimeout(timer);
    const attempt = () => {
      window.scrollTo(0, y);
      if (Math.abs(window.scrollY - y) > 2 && Date.now() < until) timer = setTimeout(attempt, 60);
    };
    attempt();
    window.addEventListener('touchstart', stop, { passive: true, once: true });
    window.addEventListener('wheel', stop, { passive: true, once: true });
    return () => {
      stop();
      window.removeEventListener('touchstart', stop);
      window.removeEventListener('wheel', stop);
    };
  }, [key]);
  return () => { wanted.current = true; };
}
