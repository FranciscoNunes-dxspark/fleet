import React from 'react';
import { cellText } from '../insights.js';
import { theme } from '../theme.js';
import { fit, stringWidth } from '@fleet/kit/text.js';
import { Row } from '@fleet/kit/ui/parts.jsx';
import { markerSegments } from '../markers.js';

/** How wide each column is drawn: as wide as its name and the widest value shown, within reason. */
export function columnWidths(table, rows = table.rows) {
  return table.columns.map((c, i) => Math.min(48, Math.max(stringWidth(c.name), ...rows.slice(0, 200).map((r) => stringWidth(cellText(r[i], c.type))), 3)));
}

/**
 * A query's result as a grid: the column names, a line, and the rows from `offset`, columns from
 * `col` on (h and l move across). The row at `index` has the cursor. `marks` ({ [row]: [markers] }, markers.js
 * rowMarkers) puts what changed the app in a column of its own before the cells, beside the row after it.
 */
export function Grid({ table, widths, width, height, offset, index, col, active, marks = null }) {
  const cols = table.columns.map((c, i) => ({ ...c, i })).slice(col);
  const gutter = (row) => (marks ? [...(row == null ? [{ text: ' ' }] : markerSegments([marks[row] ?? []], { blank: ' ' })), { text: ' ' }] : []);
  const cells = (values, style, row) => [...gutter(row), ...cols.flatMap((c) => [{ text: fit(values(c), widths[c.i]), ...style(c) }, { text: ' │ ', color: theme.border }])];
  return (
    <>
      <Row pointer={false} width={width} segments={[{ text: '  ' }, ...cells((c) => c.name, () => ({ bold: true, color: theme.accent }))]} />
      <Row pointer={false} width={width} segments={[{ text: '  ' }, ...gutter(null), { text: cols.map((c) => '─'.repeat(widths[c.i])).join('─┼─'), color: theme.border }]} />
      {table.rows.slice(offset, offset + height).map((r, k) => (
        <Row
          key={offset + k}
          width={width}
          selected={offset + k === index}
          focused={active}
          segments={cells(
            (c) => cellText(r[c.i], c.type),
            (c) => ({ color: c.name === 'success' && r[c.i] === false ? theme.del : c.name === 'resultCode' && Number(r[c.i]) >= 500 ? theme.del : undefined }),
            offset + k,
          )}
        />
      ))}
    </>
  );
}
