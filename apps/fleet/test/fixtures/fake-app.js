// A tiny app for the host's tests, in hosted mode as the real ones are (the kit's hosted.js): it draws
// its name, its size and the keys it got, whole, on a cleared screen. X exits with 3; H hands a line
// to the app named in FAKE_HANDOFF; M turns the mouse on.
import { appTerminal, handOff } from '@fleet/kit/hosted.js';

const name = process.argv[2] ?? 'fake';
const { stdin, stdout } = appTerminal();
let keys = '';
const draw = () => stdout.write(`\x1b[2J\x1b[H${name} ${stdout.columns}x${stdout.rows}\r\nkeys: ${JSON.stringify(keys)}\r\n`);
stdin.setEncoding('utf8');
stdin.setRawMode(true);
stdin.on('data', (d) => {
  if (d === 'X') process.exit(3);
  if (d === 'H') return handOff(process.env.FAKE_HANDOFF ?? 'two', '/take family:v1:commit:eyJoYXNoIjoiYWJjIn0');
  if (d === 'M') stdout.write('\x1b[?1002h\x1b[?1006h');
  keys += d;
  draw();
});
stdout.on('resize', draw);
// The alternate screen, as the apps do: the host keeps it out of its own screen.
stdout.write('\x1b[?1049h');
draw();
