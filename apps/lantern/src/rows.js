// Words and colours the views share: severities, a metric's rating, the Waterfall's bar. Colours are read
// from the theme while drawing.
import { rating } from './audit.js';
import { theme } from './theme.js';

export const SEVERITY_LABEL = { critical: 'CRIT', high: 'HIGH', medium: 'MED', low: 'LOW', unknown: '?' };

/** The colour a severity is drawn in. */
export const severityTone = (s) => ({ critical: theme.del, high: theme.del, medium: theme.warn, low: theme.info })[s] ?? theme.dim;

/** A metric's colour by Google's thresholds: good green, needs improvement yellow, poor red. */
export const metricTone = (id, value) => ({ good: theme.add, 'needs-improvement': theme.warn, poor: theme.del })[rating(id, value)] ?? theme.dim;

/** The colour of a request's type in the Waterfall. */
export const typeTone = (type) => ({ document: theme.accent, script: theme.warn, stylesheet: theme.info, image: theme.add, font: theme.bangMode, fetch: theme.dim })[type] ?? theme.dim;

/**
 * A request as a bar `width` cells wide on a time scale ending at `total` ms: [before, bar] widths, the
 * bar at least one cell.
 */
export function barCells(req, total, width) {
  if (!total || width < 2) return [0, 1];
  const from = Math.min(width - 1, Math.floor((req.start / total) * width));
  const to = Math.max(from + 1, Math.min(width, Math.ceil(((req.end ?? req.start) / total) * width)));
  return [from, to - from];
}

export const FILTER_CATEGORIES = ['all', 'perf', 'a11y', 'seo', 'security'];
export const FILTER_SEVERITIES = ['all', 'critical', 'high', 'medium', 'low'];
