// Stands in for `ssh -T … <command>`: the last argument is what to run.
const line = process.argv.at(-1);
if (line === 'hang') setInterval(() => {}, 1000);
else if (line === 'unreachable') {
  console.error('me@h: Permission denied (publickey).');
  process.exit(255);
} else if (line === 'fail') {
  console.error('nope');
  process.exit(3);
} else {
  console.log(`ran: ${line}`);
}
