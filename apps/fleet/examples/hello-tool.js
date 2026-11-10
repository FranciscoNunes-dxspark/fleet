#!/usr/bin/env node
// A team's own tool as a space in Fleet, as small as it can be: Node and nothing else. Add it to
// ~/.fleet/host.json as
//   "spaces": [{ "id": "hello", "title": "Hello", "command": ["node", "/path/to/hello-tool.js"] }]
// and it gets a tab beside the family's. docs/hosted-apps.md has the protocol this follows.
import { createReadStream } from 'node:fs';

const hosted = process.env.FLEET_HOSTED === '1';
let columns = Number(process.env.FLEET_COLUMNS) || process.stdout.columns || 80;
let rows = Number(process.env.FLEET_ROWS) || process.stdout.rows || 24;
let typed = '';

// A message for Fleet goes inside stdout, as an OSC it takes out (`ready`: this tool reads keys now).
const tellFleet = (msg) => hosted && process.stdout.write(`\x1b]5379;${JSON.stringify(msg)}\x07`);

function draw() {
  const line = (text) => String(text).slice(0, columns).padEnd(columns);
  const out = [
    line(`\x1b[1m▍ Hello\x1b[0m   a team's own tool, in a tab of Fleet's`),
    line(''),
    line(`  ${columns}×${rows} is the room Fleet gives it.`),
    line(`  Keys typed here: ${JSON.stringify(typed.slice(-30))}`),
    line(''),
    line('  q quits it (Fleet shows that it exited, and ↵ starts it again).'),
  ];
  while (out.length < rows) out.push(line(''));
  // Home, then every row whole: Fleet keeps this screen and writes it again on a switch back.
  process.stdout.write(`\x1b[?25l\x1b[H${out.join('\r\n')}`);
}

// Fleet's control pipe: newline-delimited JSON on fd 3. A resize is the size to draw at; the same size
// again means "draw it again". When the pipe ends, Fleet has quit, and so does the tool.
if (hosted) {
  let buffer = '';
  const control = createReadStream(null, { fd: 3, encoding: 'utf8' });
  control.on('data', (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buffer.slice(0, at) || '{}');
      buffer = buffer.slice(at + 1);
      if (msg.resize) ({ columns, rows } = msg.resize);
      draw();
    }
  });
  control.on('end', () => process.exit(0));
  control.on('error', () => process.exit(0));
} else process.stdout.on('resize', () => ((columns = process.stdout.columns), (rows = process.stdout.rows), draw()));

// Keys arrive on stdin as they're typed (in Fleet a pipe, already raw; in a terminal, made raw here).
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (keys) => {
  if (keys === 'q') {
    process.stdout.write('\x1b[?25h\x1b[2J\x1b[H');
    process.exit(0);
  }
  typed += keys;
  draw();
});

process.stdout.write('\x1b[2J');
draw();
tellFleet({ ready: true });
