// A query's grid as a file, for /export: CSV, JSON or a Markdown table, by the file's extension (as
// Trawl's /export writes its results). Pure; actions.js writes the text.
import { cellText } from './insights.js';

const csvCell = (v) => {
  const s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** The grid as CSV, the column names first; nothing as an empty cell, objects as JSON. */
export function toCsv(table) {
  const lines = [table.columns.map((c) => csvCell(c.name)).join(',')];
  for (const row of table.rows) lines.push(row.map(csvCell).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

/** The grid as a JSON array of objects by column name, values as Application Insights gave them. */
export function toJson(table) {
  return `${JSON.stringify(table.rows.map((r) => Object.fromEntries(table.columns.map((c, i) => [c.name, r[i] ?? null]))), null, 2)}\n`;
}

const mdCell = (s) => s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
const NUMERIC = /^(int|long|real|decimal|double)$/;

/** The grid as a Markdown table: values as the grid shows them, pipes escaped, numbers aligned right. */
export function toMarkdown(table) {
  const row = (cells) => `| ${cells.join(' | ')} |`;
  const lines = [row(table.columns.map((c) => mdCell(c.name))), row(table.columns.map((c) => (NUMERIC.test(c.type) ? '---:' : '---')))];
  for (const r of table.rows) lines.push(row(r.map((v, i) => mdCell(cellText(v, table.columns[i].type)))));
  return `${lines.join('\n')}\n`;
}

/** The writer for a file's extension (.csv, .json, .md or .markdown), or null. */
export const EXPORTS = { '.csv': toCsv, '.json': toJson, '.md': toMarkdown, '.markdown': toMarkdown };
