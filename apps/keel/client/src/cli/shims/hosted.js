// The kit's hosted.js (@fleet/kit) in the browser: the page is never inside Fleet, so there is no host
// to tell anything, and the app does what it would outside it.

/** Never hosted here: the app's /update falls back to its own. */
export function askHostToUpdate() {
  return false;
}

/** Never hosted here: nothing to hand a line to. */
export function handOff() {
  return false;
}
