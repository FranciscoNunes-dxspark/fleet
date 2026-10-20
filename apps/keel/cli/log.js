// The server code warns on the console now and then ("[boards] …", "[orgs] …"). In a full-screen
// terminal app that would scribble over the frame, so those lines are kept here and /log shows them.
import { format } from 'node:util';

const lines = [];

/** Sends console.log/info/warn/error into the log instead of the terminal. */
export function captureConsole() {
  for (const level of ['log', 'info', 'warn', 'error']) {
    console[level] = (...args) => {
      lines.push(`${new Date().toLocaleTimeString()} ${level === 'log' || level === 'info' ? '' : `${level}: `}${format(...args)}`);
      if (lines.length > 500) lines.shift();
    };
  }
}

/** Everything captured so far, oldest first. */
export const logText = () => (lines.length ? lines.join('\n') : 'Nothing logged yet.');
