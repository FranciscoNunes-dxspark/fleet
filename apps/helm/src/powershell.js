// One long-lived PowerShell process, like the ISE's: variables and functions stay between runs.
// Code goes in as one base64 line (so newlines and quotes survive), runs dot-sourced in the loop's
// own scope, and its output comes back line by line until a marker line says it finished.
import { spawn } from 'node:child_process';

/** An error line starts with this; the screen draws it red and drops the mark. */
export const ERROR_MARK = '';
/** Warning and verbose/debug lines start with these. */
export const WARN_MARK = '';
export const VERBOSE_MARK = '';
export const DONE = '\x01HELM-DONE\x01';

// The loop the process runs. Everything the code writes (any stream) is merged and formatted as the console would.
const LOOP = `
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
function Write-HelmError($text) { foreach ($l in ($text -split "\r?\n")) { [Console]::Out.WriteLine([string][char]2 + $l) } }
function Write-HelmMark($n, $text) { foreach ($l in ($text -split "\r?\n")) { [Console]::Out.WriteLine([string][char]$n + $l) } }
while ($null -ne ($line = [Console]::In.ReadLine())) {
  try {
    $code = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line))
    . ([scriptblock]::Create($code)) *>&1 | ForEach-Object {
      if ($_ -is [Management.Automation.ErrorRecord]) { Write-HelmError $_.Exception.Message }
      elseif ($_ -is [Management.Automation.WarningRecord]) { Write-HelmMark 3 $_.Message }
      elseif ($_ -is [Management.Automation.VerboseRecord] -or $_ -is [Management.Automation.DebugRecord]) { Write-HelmMark 4 $_.Message }
      else { ($_ | Out-String -Stream) | ForEach-Object { [Console]::Out.WriteLine($_) } }
    }
  } catch {
    $e = $_.Exception
    if ($e.InnerException) { $e = $e.InnerException }
    Write-HelmError $e.Message
  }
  [Console]::Out.WriteLine([string][char]1 + 'HELM-DONE' + [char]1)
  [Console]::Out.Flush()
}
`;

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

export const encodeCode = (code) => Buffer.from(code, 'utf8').toString('base64');

/** UTF-16LE base64, which is what -EncodedCommand takes. */
const encodeCommand = (text) => Buffer.from(text, 'utf16le').toString('base64');

/**
 * A session over `bin`. `run(code, onLine)` resolves when the code finishes; runs queue up behind one
 * another. `stop()` kills the process (the only way to interrupt a running script), so the next run
 * starts a fresh session with its variables gone. `spawnImpl` is for tests.
 */
export function createSession({ bin, cwd = process.cwd(), spawnImpl = spawn } = {}) {
  let child = null;
  let queue = Promise.resolve();
  let current = null;

  const start = () => {
    child = spawnImpl(bin, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodeCommand(LOOP)], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let pending = '';
    const feed = (chunk) => {
      pending += chunk.toString('utf8');
      let i;
      while ((i = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, i).replace(/\r+$/, '');
        pending = pending.slice(i + 1);
        if (!current) continue;
        if (line === DONE) current.finish();
        else current.onLine(line);
      }
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('error', (err) => current?.fail(err));
    child.on('exit', () => {
      child = null;
      // A process that died mid-run ends that run (stop() was asked, or it crashed).
      current?.finish(true);
    });
  };

  const runNow = (code, onLine) =>
    new Promise((resolve, reject) => {
      if (!child) start();
      let over = false;
      current = {
        onLine,
        finish: (killed = false) => {
          if (over) return;
          over = true;
          current = null;
          resolve({ stopped: killed });
        },
        fail: (err) => {
          if (over) return;
          over = true;
          current = null;
          reject(err);
        },
      };
      child.stdin.write(encodeCode(code) + '\n');
    });

  return {
    bin,
    run(code, onLine = () => {}) {
      const result = queue.then(() => runNow(code, onLine));
      queue = result.catch(() => {});
      return result;
    },
    stop() {
      if (child) child.kill();
    },
    close() {
      if (child) child.kill();
    },
  };
}
