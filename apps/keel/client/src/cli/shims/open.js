// cli/open.js in the browser: links open in a new tab, and the version is the checkout's.
import { version } from '../../../../package.json';

/** Opens a URL in a new tab. */
export function openUrl(url) {
  window.open(url, '_blank', 'noopener,noreferrer');
}

export const VERSION = version;

/** Never a downloaded executable here, so nothing to update. */
export const COMPILED = false;
