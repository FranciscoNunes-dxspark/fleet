// cli/clipboard.js in the browser: the page's clipboard, then the terminal's (OSC 52) as the app would.
import { osc52 } from '../../../../cli/selection.js';

/** Copies `text`: 'system' when the browser took it, 'terminal' when it went by OSC 52. */
export async function copyToClipboard(text, { write } = {}) {
  try {
    await navigator.clipboard.writeText(text);
    return 'system';
  } catch {
    write?.(osc52(text));
    return 'terminal';
  }
}
