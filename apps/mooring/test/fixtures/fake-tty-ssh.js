// Stands in for `ssh -tt … <command>`: a tiny shell. It shows the arguments it got, prompts with "$ " and, for each
// line typed, echoes it as a terminal would and answers; `exit` ends it, `vim` draws a full screen.
// A second ssh (`-T`, the stty that resizes) just ends. The shell reports its tty first, as the real start command does
// (FAKE_TTY names what it says, so a test can have it lie).
if (process.argv.includes('-T')) process.exit(0);
process.stdout.write(`\x1b]5380;${process.env.FAKE_TTY ?? '/dev/pts/9'}\x07args: ${JSON.stringify(process.argv.slice(2))}\r\nTERM=${process.env.TERM}\r\nfake$ `);
let line = '';
process.stdin.setEncoding('utf8').on('data', (d) => {
  for (const ch of d) {
    if (ch !== '\r') {
      line += ch;
      process.stdout.write(ch);
      continue;
    }
    process.stdout.write('\r\n');
    if (line === 'exit') process.exit(0);
    if (line === 'vim') process.stdout.write('\x1b[?1049h\x1b[2J\x1b[1;1Hfull screen');
    else if (line) process.stdout.write(`got: ${line}\r\n`);
    process.stdout.write('fake$ ');
    line = '';
  }
});
