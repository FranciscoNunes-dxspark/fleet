// Helm's console: one interactive PowerShell with a terminal of its own, drawn through the kit's virtual terminal
// (vt.js), as Mooring's Console draws a shell on a server. Every key typed in the Console view goes to it as it came,
// so PowerShell's own line editor (PSReadLine) does the completion, the history and Ctrl+C; F5 and F8 type the run
// into the same shell, so variables stay between runs as in the ISE.
//
// The terminal, without a native module (Fleet's Bun builds can't carry one):
// - Linux and macOS: `script`, which gives the program it runs a pty of its own. The shell says which tty it got (an
//   OSC 5380 printed before PowerShell starts, taken out of the output here), and a resize is `stty` on that tty, after
//   which the kernel tells PowerShell (SIGWINCH).
// - Windows: a pseudo console (ConPTY), opened by a small relay: Windows PowerShell or pwsh compiling RELAY_SOURCE once
//   with Add-Type (kept as a DLL in the temp folder), which runs PowerShell in the pseudo console and copies bytes both
//   ways. A resize goes to the relay in-band, as `ESC ] 5381 ; columns ; rows BEL` on its input.
//
// The prompt says how each command went: SETUP wraps PowerShell's `prompt` function to print `ESC ] 5381 ; 1 BEL`
// (or 0 when the command failed or wrote an error) before the prompt, which is taken out of the output and handed to
// `onPrompt`. A terminal that never shows one (an older Windows' pseudo console can drop sequences it doesn't know)
// still works; Helm just can't tell when a run is over.
import { spawn as spawnProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { VirtualTerminal } from '@fleet/kit/vt.js';

export const SCROLLBACK = 5000;
const TTY_PATH = /^\/dev\/[\w/.-]+$/;
const RESIZE_DELAY_MS = 60;

/** What PowerShell runs before its first prompt: the prompt wrapped to say how the last command went. */
export const SETUP = `
Remove-Item Env:HELM_PTY_COMMAND, Env:HELM_PTY_SIZE, Env:HELM_PTY_HASH -ErrorAction SilentlyContinue
$global:__helmLastError = $Error[0]
$global:__helmPrompt = $function:prompt
function global:prompt {
  $ok = $?
  if ($Error.Count -and -not [object]::ReferenceEquals($Error[0], $global:__helmLastError)) { $ok = $false; $global:__helmLastError = $Error[0] }
  [Console]::Write([string][char]27 + ']5381;' + [int]$ok + [char]7)
  if ($global:__helmPrompt) { & $global:__helmPrompt } else { "PS $($executionContext.SessionState.Path.CurrentLocation)> " }
}
`;

/** UTF-16LE base64, which is what -EncodedCommand takes. */
export const encodeCommand = (text) => Buffer.from(text, 'utf16le').toString('base64');

/** The arguments PowerShell starts with: interactive, after SETUP. Base64 only, so no shell's quoting can touch them. */
export const shellArgs = () => ['-NoLogo', '-NoExit', '-EncodedCommand', encodeCommand(SETUP)];

const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// One argument for a Windows command line, as CommandLineToArgvW reads it back.
function winQuote(arg) {
  const s = String(arg);
  if (s && !/[\s"]/.test(s)) return s;
  let out = '"';
  let slashes = 0;
  for (const c of s) {
    if (c === '\\') slashes++;
    else if (c === '"') {
      out += '\\'.repeat(slashes * 2 + 1) + '"';
      slashes = 0;
    } else {
      out += '\\'.repeat(slashes) + c;
      slashes = 0;
    }
  }
  return `${out}${'\\'.repeat(slashes * 2)}"`;
}

// The relay's pseudo console. C# 5, as Windows PowerShell's compiler takes it.
const RELAY_SOURCE = String.raw`
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class HelmPty
{
    [StructLayout(LayoutKind.Sequential)]
    struct COORD { public short X; public short Y; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO
    {
        public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
        public int dwX; public int dwY; public int dwXSize; public int dwYSize;
        public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute; public int dwFlags;
        public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2;
        public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CreatePipe(out SafeFileHandle read, out SafeFileHandle write, IntPtr attributes, int size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern int CreatePseudoConsole(COORD size, SafeFileHandle input, SafeFileHandle output, uint flags, out IntPtr console);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern int ResizePseudoConsole(IntPtr console, COORD size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern void ClosePseudoConsole(IntPtr console);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory, ref STARTUPINFOEX startup, out PROCESS_INFORMATION info);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);

    const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    const int STARTF_USESTDHANDLES = 0x00000100;
    static readonly IntPtr PSEUDOCONSOLE = (IntPtr)0x00020016;
    static readonly byte[] RESIZE = Encoding.ASCII.GetBytes("\x1b]5381;");

    static IntPtr console;
    static int closed;

    static COORD Size(int columns, int rows)
    {
        COORD c = new COORD();
        c.X = (short)Math.Max(1, Math.Min(columns, 2000));
        c.Y = (short)Math.Max(1, Math.Min(rows, 2000));
        return c;
    }

    static void Close()
    {
        if (Interlocked.Exchange(ref closed, 1) == 0) ClosePseudoConsole(console);
    }

    static void Resize(string body)
    {
        string[] parts = body.Split(';');
        int columns, rows;
        if (parts.Length == 2 && int.TryParse(parts[0], out columns) && int.TryParse(parts[1], out rows) && closed == 0) ResizePseudoConsole(console, Size(columns, rows));
    }

    // Our input to the pseudo console's, but for the resize messages, which a write always sends whole.
    static void Pump(Stream from, Stream to)
    {
        byte[] buf = new byte[8192];
        MemoryStream keys = new MemoryStream();
        int matched = 0;
        StringBuilder body = null;
        int n;
        while ((n = from.Read(buf, 0, buf.Length)) > 0)
        {
            keys.SetLength(0);
            for (int i = 0; i < n; i++)
            {
                byte b = buf[i];
                if (body != null)
                {
                    if (b == 7) { Resize(body.ToString()); body = null; }
                    else if (body.Length < 32) body.Append((char)b);
                    else body = null;
                    continue;
                }
                if (b == RESIZE[matched])
                {
                    matched++;
                    if (matched == RESIZE.Length) { matched = 0; body = new StringBuilder(); }
                    continue;
                }
                if (matched > 0)
                {
                    keys.Write(RESIZE, 0, matched);
                    matched = 0;
                    if (b == RESIZE[0]) { matched = 1; continue; }
                }
                keys.WriteByte(b);
            }
            // A lone escape key must not wait for the next one.
            if (matched > 0 && body == null) { keys.Write(RESIZE, 0, matched); matched = 0; }
            if (keys.Length > 0) { to.Write(keys.GetBuffer(), 0, (int)keys.Length); to.Flush(); }
        }
    }

    public static int Run(string commandLine, int columns, int rows)
    {
        SafeFileHandle inRead, inWrite, outRead, outWrite;
        if (!CreatePipe(out inRead, out inWrite, IntPtr.Zero, 0) || !CreatePipe(out outRead, out outWrite, IntPtr.Zero, 0))
            throw new InvalidOperationException("Couldn't make the pseudo console's pipes (" + Marshal.GetLastWin32Error() + ")");
        int hr = CreatePseudoConsole(Size(columns, rows), inRead, outWrite, 0, out console);
        if (hr != 0) throw new InvalidOperationException("Couldn't open a pseudo console (" + hr + "): it needs Windows 10 1809 or later");
        // The pseudo console holds its own ends now.
        inRead.Dispose();
        outWrite.Dispose();

        IntPtr size = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
        IntPtr list = Marshal.AllocHGlobal(size);
        if (!InitializeProcThreadAttributeList(list, 1, 0, ref size) || !UpdateProcThreadAttribute(list, 0, PSEUDOCONSOLE, console, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero))
            throw new InvalidOperationException("Couldn't attach the pseudo console (" + Marshal.GetLastWin32Error() + ")");
        STARTUPINFOEX startup = new STARTUPINFOEX();
        startup.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
        // No standard handles of ours (pipes to Helm): the program gets the pseudo console's.
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.lpAttributeList = list;
        PROCESS_INFORMATION info;
        if (!CreateProcessW(null, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, false, EXTENDED_STARTUPINFO_PRESENT, IntPtr.Zero, null, ref startup, out info))
            throw new InvalidOperationException("Couldn't start " + commandLine.Split(' ')[0] + " (" + Marshal.GetLastWin32Error() + ")");
        CloseHandle(info.hThread);

        Stream stdout = Console.OpenStandardOutput();
        Stream stdin = Console.OpenStandardInput();
        FileStream fromConsole = new FileStream(outRead, FileAccess.Read, 1, false);
        FileStream toConsole = new FileStream(inWrite, FileAccess.Write, 1, false);
        Thread output = new Thread(delegate()
        {
            byte[] buf = new byte[16384];
            int n;
            try { while ((n = fromConsole.Read(buf, 0, buf.Length)) > 0) { stdout.Write(buf, 0, n); stdout.Flush(); } }
            catch (Exception) { }
        });
        output.IsBackground = true;
        output.Start();
        // Helm closing our input ends the program: closing the pseudo console closes what runs in it.
        Thread input = new Thread(delegate()
        {
            try { Pump(stdin, toConsole); } catch (Exception) { }
            Close();
        });
        input.IsBackground = true;
        input.Start();

        WaitForSingleObject(info.hProcess, 0xFFFFFFFF);
        uint code;
        GetExitCodeProcess(info.hProcess, out code);
        CloseHandle(info.hProcess);
        // What it wrote last is still on its way: the pseudo console sends it before its pipe ends.
        Close();
        output.Join(2000);
        return (int)code;
    }
}
`;

// The relay itself: compiles RELAY_SOURCE once into a DLL in the temp folder (by its hash and the PowerShell's
// edition, since each compiles for its own .NET), else in memory, and runs it.
const RELAY = `
$ErrorActionPreference = 'Stop'
$source = @'
${RELAY_SOURCE}
'@
if (-not ('HelmPty' -as [type])) {
  $dll = Join-Path ([IO.Path]::GetTempPath()) ('helm-pty-' + $env:HELM_PTY_HASH + '-' + $PSVersionTable.PSEdition + '.dll')
  try {
    if (-not (Test-Path -LiteralPath $dll)) {
      $part = $dll + '.' + $PID + '.dll'
      Add-Type -TypeDefinition $source -OutputAssembly $part -OutputType Library
      Move-Item -LiteralPath $part -Destination $dll -Force
    }
    if (-not ('HelmPty' -as [type])) { Add-Type -LiteralPath $dll }
  } catch {
    if (-not ('HelmPty' -as [type])) { Add-Type -TypeDefinition $source }
  }
}
$size = $env:HELM_PTY_SIZE -split ','
exit [HelmPty]::Run($env:HELM_PTY_COMMAND, [int]$size[0], [int]$size[1])
`;
const RELAY_HASH = createHash('sha256').update(RELAY_SOURCE).digest('hex').slice(0, 12);

/**
 * How to start `bin args…` with a terminal on `platform`: { command, args, env, resize } for spawn, where `resize` is
 * 'stty' (the tty the shell reports) or 'relay' (a message to the relay). Pure.
 */
export function launchFor({ platform = process.platform, bin, args = shellArgs(), columns = 80, rows = 24, env = process.env }) {
  if (platform === 'win32') {
    const relayBin = /^pwsh(\.exe)?$/i.test(bin) ? bin : 'powershell';
    return {
      command: relayBin,
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodeCommand(RELAY)],
      env: { ...env, HELM_PTY_COMMAND: [bin, ...args].map(winQuote).join(' '), HELM_PTY_SIZE: `${columns},${rows}`, HELM_PTY_HASH: RELAY_HASH },
      resize: 'relay',
    };
  }
  // The size first, then the tty reported, then the program in place of the shell; the user's own SHELL put back.
  const inner = [
    `if [ -n "$HELM_USER_SHELL" ]; then SHELL=$HELM_USER_SHELL; export SHELL; fi; unset HELM_USER_SHELL`,
    `stty cols ${columns} rows ${rows} 2>/dev/null`,
    `printf '\\033]5380;%s\\007' "$(tty 2>/dev/null)"`,
    `exec ${[bin, ...args].map(shQuote).join(' ')}`,
  ].join('; ');
  const shellEnv = { ...env, TERM: 'xterm-256color', SHELL: '/bin/sh', HELM_USER_SHELL: env.SHELL ?? '' };
  // BSD's script takes the program as its arguments; util-linux's takes a command line for $SHELL (here sh).
  if (platform === 'darwin') return { command: 'script', args: ['-q', '/dev/null', '/bin/sh', '-c', inner], env: shellEnv, resize: 'stty' };
  return { command: 'script', args: ['-qfec', inner, '/dev/null'], env: shellEnv, resize: 'stty' };
}

/** What `stty` is run with to give the tty a new size: GNU's names it with -F, BSD's with -f. */
export const sttyArgs = (platform, tty, columns, rows) => [platform === 'darwin' ? '-f' : '-F', tty, 'cols', String(columns), 'rows', String(rows)];

// The sequences taken out of the shell's output: the tty (OSC 5380), the prompt's word (OSC 5381), and the questions a
// terminal answers (where the cursor is, whether it's well, what it is), which PowerShell asks on Linux and macOS.
const TAKEN = /\x1b\]538[01];[^\x07\x1b]{0,256}\x07|\x1b\[[56]n|\x1b\[0?c/g;
const PREFIXES = ['\x1b]5380;', '\x1b]5381;', '\x1b[6n', '\x1b[5n', '\x1b[0c', '\x1b[c'];

/**
 * Reads the shell's output into `vt`: what is the terminal's goes in; the marks go to `onMark(code, body)` and the
 * questions are answered through `answer(text)`, each where it came, so the cursor's place is the one it asked about.
 * A chunk that ends partway into one of them waits for the next.
 */
export function outputReader(vt, { onMark = () => {}, answer = () => {} } = {}) {
  let held = '';
  return (data) => {
    let s = held + data;
    held = '';
    // The start of a mark or question at the very end: kept for the next chunk (an unfinished mark, up to its length).
    const esc = s.lastIndexOf('\x1b');
    if (esc >= 0) {
      const tail = s.slice(esc);
      const open = PREFIXES.some((p) => p.length > tail.length && p.startsWith(tail)) || (/^\x1b\]538[01];/.test(tail) && !tail.includes('\x07') && tail.length < 270);
      if (open) {
        held = tail;
        s = s.slice(0, esc);
      }
    }
    let at = 0;
    for (const m of s.matchAll(TAKEN)) {
      vt.write(s.slice(at, m.index));
      at = m.index + m[0].length;
      const q = m[0];
      if (q.startsWith('\x1b]')) onMark(q.slice(2, 6), q.slice(7, -1));
      else if (q === '\x1b[6n') answer(`\x1b[${vt.y + 1};${vt.x + 1}R`);
      else if (q === '\x1b[5n') answer('\x1b[0n');
      else answer('\x1b[?1;2c');
    }
    vt.write(s.slice(at));
  };
}

/**
 * Opens PowerShell (`bin`, `args`) in a terminal `columns` × `rows`, in `cwd`. `onChange` hears that the screen
 * changed (coalesced), `onPrompt(ok)` that a prompt came back after a command that went well or not, `onExit({ code,
 * signal, error })` that the shell is over. Returns { vt, write, resize, close, alive, marks } (`write` takes the bytes
 * of keys, as the terminal sent them; `marks` says whether a prompt has said how a command went yet). `spawn` and
 * `platform` are for tests.
 */
export function openTerminal({ bin, args, cwd = process.cwd(), platform = process.platform, spawn = spawnProcess, columns = 80, rows = 24, scrollback = SCROLLBACK, env = process.env, onChange = () => {}, onPrompt = () => {}, onExit = () => {} }) {
  const vt = new VirtualTerminal(columns, rows, { scrollback });
  const launch = launchFor({ platform, bin, args, columns, rows, env });
  const child = spawn(launch.command, launch.args, { cwd, env: launch.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let alive = true;
  let marks = false;
  let tty = null;
  let timer = null;
  const changed = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      onChange();
    }, 16);
  };
  const send = (text) => {
    if (alive) child.stdin.write(text);
  };
  const read = outputReader(vt, {
    answer: send,
    onMark: (code, body) => {
      if (code === '5380') {
        // Believed only as a path under /dev: it is passed to stty.
        if (!tty && TTY_PATH.test(body)) tty = body;
      } else if (body === '0' || body === '1') {
        marks = true;
        onPrompt(body === '1');
      }
    },
  });

  // A new size: this screen now, the shell's once the size has settled; one stty at a time, the last size wins.
  let wanted = null;
  let resizing = false;
  let resizeTimer = null;
  const tell = async () => {
    if (resizing || !wanted || !alive) return;
    const { columns: c, rows: r } = wanted;
    if (launch.resize === 'relay') {
      wanted = null;
      return send(`\x1b]5381;${c};${r}\x07`);
    }
    if (!tty) return;
    wanted = null;
    resizing = true;
    await new Promise((done) => {
      try {
        const helper = spawn('stty', sttyArgs(platform, tty, c, r), { stdio: 'ignore', windowsHide: true });
        helper.on('error', done);
        helper.on('close', done);
      } catch {
        done();
      }
    });
    resizing = false;
    if (wanted) tell();
  };

  child.stdout.setEncoding('utf8').on('data', (d) => (read(d), changed()));
  // The relay's or script's own complaints come as plain lines.
  child.stderr.setEncoding('utf8').on('data', (d) => (vt.write(d.replace(/\r?\n/g, '\r\n')), changed()));
  child.stdin.on('error', () => {});
  const over = (info) => {
    if (!alive) return;
    alive = false;
    clearTimeout(timer);
    clearTimeout(resizeTimer);
    onChange();
    onExit(info);
  };
  child.on('error', (error) => over({ code: null, error }));
  child.on('close', (code, signal) => over({ code, signal }));
  return {
    vt,
    bin,
    get alive() {
      return alive;
    },
    get marks() {
      return marks;
    },
    write(bytes) {
      // Nothing typed can pass for the relay's resize message.
      send(launch.resize === 'relay' ? String(bytes).replaceAll('\x1b]5381;', '') : bytes);
    },
    resize(c, r) {
      if (!alive || (c === vt.columns && r === vt.rows)) return;
      vt.fit(c, r);
      changed();
      wanted = { columns: vt.columns, rows: vt.rows };
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(tell, RESIZE_DELAY_MS);
    },
    close() {
      if (!alive) return;
      alive = false;
      clearTimeout(timer);
      clearTimeout(resizeTimer);
      try {
        // Its input ending ends the relay's pseudo console; script hangs up its pty.
        child.stdin.end();
        const kill = setTimeout(() => child.kill(), 1000);
        kill.unref?.();
        child.once('close', () => clearTimeout(kill));
        if (platform !== 'win32') child.kill();
      } catch {
        // already gone
      }
    },
  };
}
