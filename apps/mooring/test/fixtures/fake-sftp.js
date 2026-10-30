// Stands in for sftp (`node fake-sftp.js`, batch on stdin) and for ssh (`node fake-sftp.js --ssh <command>`).
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
if (argv[0] === '--ssh') {
  const line = argv[1];
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
} else {
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    console.log(`sftp> ${line}`);
    if (line === 'pwd') console.log('Remote working directory: /home/me');
    else if (line.startsWith('ls ')) {
      if (line.includes('/nope')) {
        console.error('Can\'t ls: "/nope" not found');
        process.exit(1);
      }
      console.log('drwxr-xr-x    2 me       me           4096 Oct 29 09:30 .');
      console.log('-rw-r--r--    1 me       me            100 Jan  2  2025 b.txt');
      console.log('drwxr-xr-x    2 me       me           4096 Oct 29 09:30 a dir');
    } else if (line.startsWith('hang')) setInterval(() => {}, 1000);
  });
}
