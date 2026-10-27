// The split view's geometry, pure: two panes side by side above the bar, a one-column divider between
// them, and the mouse reports the host reads taken apart by the pane they fall in, each moved into
// its pane's own columns (an app draws and reads clicks as if its pane were the whole screen).

/** Below this many columns the screen isn't split: each app would get too little to draw in. */
export const MIN_SPLIT_COLUMNS = 40;

/** The two panes at `columns`: [{ x, width }] (x the first column, 0-based); the divider is at the left one's width. */
export function splitLayout(columns) {
  const left = Math.floor((columns - 1) / 2);
  return [
    { x: 0, width: left },
    { x: left + 1, width: columns - left - 1 },
  ];
}

/** The pane (its index) at column `x` (0-based), or -1 on the divider or off them. */
export function paneAt(panes, x) {
  return panes.findIndex((p) => x >= p.x && x < p.x + p.width);
}

const SGR_MOUSE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

/**
 * Takes the SGR mouse reports out of `data` for the panes: { data, reports }, `data` the rest (the
 * keys, for the focused app), `reports` [{ pane, data, press }] each moved into its pane's columns,
 * `press` whether a button went down (a click there focuses the pane). Reports on the divider go
 * nowhere.
 */
export function takePaneMouse(data, panes) {
  const reports = [];
  const rest = data.replace(SGR_MOUSE, (all, b, x, y, end) => {
    const pane = paneAt(panes, Number(x) - 1);
    if (pane < 0) return '';
    const code = Number(b);
    // Motion (32) and the wheel (64) aren't a click.
    const press = end === 'M' && (code & (32 | 64)) === 0;
    reports.push({ pane, data: `\x1b[<${b};${Number(x) - panes[pane].x};${y}${end}`, press });
    return '';
  });
  return { data: rest, reports };
}
