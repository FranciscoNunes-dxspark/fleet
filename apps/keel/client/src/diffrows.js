/**
 * A hunk's lines as rows of two sides: unchanged lines on both, and each run of removed lines
 * paired with the added lines that follow it (the old version of a line beside its new one).
 */
export function splitRows(lines) {
  const rows = [];
  for (let i = 0; i < lines.length;) {
    if (lines[i].t === ' ') { rows.push({ left: lines[i], right: lines[i] }); i++; continue; }
    const del = [];
    const add = [];
    while (i < lines.length && lines[i].t === '-') del.push(lines[i++]);
    while (i < lines.length && lines[i].t === '+') add.push(lines[i++]);
    for (let k = 0; k < Math.max(del.length, add.length); k++) rows.push({ left: del[k] || null, right: add[k] || null });
  }
  return rows;
}
