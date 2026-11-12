// Which PowerShell Helm runs: pwsh (PowerShell 7) when there is one, else Windows PowerShell on Windows. The shell
// itself, with a terminal of its own, is terminal.js's.
import { spawn } from 'node:child_process';

function probe(bin) {
  try {
    const r = spawn(bin, ['-NoLogo', '-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore', windowsHide: true });
    return new Promise((ok) => {
      r.on('error', () => ok(false));
      r.on('exit', (code) => ok(code === 0));
    });
  } catch {
    return Promise.resolve(false);
  }
}

/** The program to run: pwsh (PowerShell 7) when there is one, else Windows PowerShell on Windows, or null. */
export async function locate(options = {}) {
  const { platform = process.platform, exists = probe } = options;
  for (const bin of platform === 'win32' ? ['pwsh', 'powershell'] : ['pwsh']) if (await exists(bin)) return bin;
  return null;
}
