// The kit's run.js, but with each line of output handed over as it comes: an apply can take many
// minutes, and its log should say what it's doing while it does it. Only /apply uses it. The same
// rules as run.js: through the shell, no terminal and stdin closed (so nothing waits on a prompt),
// and an abort kills the whole process tree. Kept here rather than in the kit until another app
// needs it (run.js's `onLine` option would replace it).
import { spawn } from 'node:child_process';
import { RunError } from '@fleet/kit/run.js';

/** Runs `command`, calling `onLine(line)` for each line of stdout and stderr as it's written; resolves { stdout, stderr }. */
export function runStreaming(command, { cwd = process.cwd(), signal, env, onLine = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true, env: { ...process.env, ...env }, detached: process.platform !== 'win32' });
    const out = { stdout: '', stderr: '' };
    const partial = { stdout: '', stderr: '' };
    let cancelled = false;
    const take = (which) => (d) => {
      out[which] += d;
      const lines = (partial[which] + d).split(/\r?\n/);
      partial[which] = lines.pop();
      for (const l of lines) onLine(l);
    };
    child.stdout.setEncoding('utf8').on('data', take('stdout'));
    child.stderr.setEncoding('utf8').on('data', take('stderr'));
    const kill = () => {
      cancelled = true;
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      else {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          child.kill('SIGTERM');
        }
      }
    };
    if (signal?.aborted) kill();
    signal?.addEventListener('abort', kill, { once: true });
    child.on('error', (e) => reject(new RunError(e.message, out)));
    child.on('close', (code) => {
      signal?.removeEventListener('abort', kill);
      for (const which of ['stdout', 'stderr']) if (partial[which]) onLine(partial[which]);
      if (cancelled) return reject(new RunError('Cancelled', { ...out, cancelled: true }));
      if (code === 0) return resolve(out);
      reject(new RunError(out.stderr.trim() || out.stdout.trim() || `${command} exited with ${code}`, { code, ...out }));
    });
    child.stdin.on('error', () => {});
    child.stdin.end('');
  });
}
