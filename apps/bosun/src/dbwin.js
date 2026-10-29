// Trace.WriteLine and Debug.WriteLine (OutputDebugString underneath) for processes with "trace": on
// Windows that output goes to whoever listens on the DBWIN_BUFFER shared memory, as DebugView does,
// and nowhere else, so a .NET Framework site or service otherwise says it to no one. One helper for
// all of Bosun (the buffer has one reader at a time): Windows PowerShell compiling a small C# reader
// at run time, listening in this session and in session 0 (IIS's workers; that needs an
// administrator), and writing `pid<TAB>parent,grandparent…<TAB>text` lines. Each process takes the
// lines from its own process tree. The helper ends when Bosun does, however it ends. Parsing and
// routing are pure; `DebugOutput` starts the helper with its first subscriber and stops it with its last.
import { spawn } from 'node:child_process';

// The C# reader. Bytes are copied out and the buffer handed back before anything slow (asking WMI for
// a new process's parents), as a writer waits for it.
const READER = String.raw`
using System;
using System.Collections.Generic;
using System.IO;
using System.IO.MemoryMappedFiles;
using System.Management;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;

public static class BosunDbwin {
  static readonly object Gate = new object();
  static readonly Dictionary<int, string> Chains = new Dictionary<int, string>();

  static void Say(string line) {
    lock (Gate) { Console.Out.WriteLine(line); Console.Out.Flush(); }
  }

  static string Chain(int pid) {
    lock (Chains) { string known; if (Chains.TryGetValue(pid, out known)) return known; }
    var parents = new List<string>();
    int at = pid;
    for (int i = 0; i < 16; i++) {
      try {
        using (var p = new ManagementObject("Win32_Process.Handle='" + at + "'")) {
          p.Get();
          int parent = Convert.ToInt32(p["ParentProcessId"]);
          if (parent <= 4 || parent == at) break;
          parents.Add(parent.ToString());
          at = parent;
        }
      } catch { break; }
    }
    string chain = string.Join(",", parents.ToArray());
    lock (Chains) { Chains[pid] = chain; }
    return chain;
  }

  static void Listen(string prefix) {
    try {
      var everyone = new SecurityIdentifier(WellKnownSidType.WorldSid, null);
      var eventRights = new EventWaitHandleSecurity();
      eventRights.AddAccessRule(new EventWaitHandleAccessRule(everyone, EventWaitHandleRights.FullControl, AccessControlType.Allow));
      var mapRights = new MemoryMappedFileSecurity();
      mapRights.AddAccessRule(new AccessRule<MemoryMappedFileRights>(everyone, MemoryMappedFileRights.FullControl, AccessControlType.Allow));
      bool created;
      var ready = new EventWaitHandle(false, EventResetMode.AutoReset, prefix + "DBWIN_BUFFER_READY", out created, eventRights);
      if (!created) { Say("!\t" + prefix + "\tanother debug-output reader is running (DebugView, or another Bosun)"); return; }
      var data = new EventWaitHandle(false, EventResetMode.AutoReset, prefix + "DBWIN_DATA_READY", out created, eventRights);
      var map = MemoryMappedFile.CreateOrOpen(prefix + "DBWIN_BUFFER", 4096, MemoryMappedFileAccess.ReadWrite, MemoryMappedFileOptions.None, mapRights, HandleInheritability.None);
      var view = map.CreateViewAccessor(0, 4096);
      var bytes = new byte[4092];
      ready.Set();
      while (true) {
        data.WaitOne();
        int pid = view.ReadInt32(0);
        view.ReadArray(4, bytes, 0, bytes.Length);
        ready.Set();
        int n = Array.IndexOf(bytes, (byte)0);
        if (n < 0) n = bytes.Length;
        string text = Encoding.Default.GetString(bytes, 0, n);
        string chain = Chain(pid);
        foreach (var line in text.Split('\n')) {
          var t = line.TrimEnd('\r');
          if (t.Length > 0) Say(pid + "\t" + chain + "\t" + t);
        }
      }
    } catch (Exception e) {
      Say("!\t" + prefix + "\t" + e.Message.Replace("\r", " ").Replace("\n", " "));
    }
  }

  public static void Run(int bosun) {
    var here = new Thread(() => Listen("")); here.IsBackground = true; here.Start();
    var global = new Thread(() => Listen("Global\\")); global.IsBackground = true; global.Start();
    Say("ready\t\t");
    // Gone with Bosun, even when it was killed and couldn't say.
    while (true) {
      Thread.Sleep(2000);
      try { if (System.Diagnostics.Process.GetProcessById(bosun).HasExited) return; } catch { return; }
    }
  }
}
`;

/** The PowerShell that runs the reader for Bosun's process `pid`. */
export const dbwinScript = (pid) => `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -ReferencedAssemblies System.Core, System.Management -TypeDefinition @'
${READER.trim()}
'@
[BosunDbwin]::Run(${Number(pid)})
`;

/** The helper's command: Windows PowerShell (5.1, which has the access-control overloads it needs), the script encoded so nothing in it needs quoting. */
export const dbwinCommand = (pid) => ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(dbwinScript(pid), 'utf16le').toString('base64')]];

/**
 * A helper's line: { pid, chain (its parents' pids, nearest first), text }, { ready: true },
 * { problem, global } (a reader that couldn't start: `global` for session 0's), or null.
 */
export function parseDbwin(line) {
  const parts = String(line ?? '').replace(/\r$/, '').split('\t');
  if (parts.length < 3) return null;
  if (parts[0] === 'ready') return { ready: true };
  if (parts[0] === '!') return { problem: parts.slice(2).join('\t'), global: parts[1].startsWith('Global') };
  const pid = Number(parts[0]);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return { pid, chain: parts[1] ? parts[1].split(',').map(Number).filter(Boolean) : [], text: parts.slice(2).join('\t') };
}

/** Whether a line came from one of `roots` or something under one. */
export const fromTree = (entry, roots) => roots.some((r) => r && (r === entry.pid || entry.chain.includes(r)));

/** What a reader's problem means for the log. */
export function problemNote({ problem, global }) {
  if (global && /privilege|denied|access/i.test(problem)) return "can't hear IIS's workers (session 0) without an administrator's terminal: only this session's processes are heard";
  return `${global ? "session 0's" : "this session's"} debug output can't be heard: ${problem}`;
}

/**
 * The one helper, shared: `subscribe({ wants(entry), line(entry), problem(text) })` starts it when it
 * isn't running and returns the unsubscribe, which stops it after the last one. `spawnImpl` starts it
 * (tests pass a fake child).
 */
export class DebugOutput {
  constructor({ spawnImpl = spawn, pid = process.pid } = {}) {
    this.spawnImpl = spawnImpl;
    this.pid = pid;
    this.subs = new Set();
    this.problems = [];
    this.child = null;
  }

  subscribe(sub) {
    this.subs.add(sub);
    for (const p of this.problems) sub.problem?.(p);
    if (!this.child) this.start();
    return () => {
      this.subs.delete(sub);
      if (!this.subs.size) this.stop();
    };
  }

  start() {
    const [file, args] = dbwinCommand(this.pid);
    let child;
    try {
      child = this.spawnImpl(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return this.tell(`the debug-output reader couldn't start: ${e.message}`);
    }
    this.child = child;
    this.problems = [];
    let rest = '';
    let errors = '';
    child.stdout?.setEncoding('utf8').on('data', (d) => {
      const lines = `${rest}${d}`.split('\n');
      rest = lines.pop();
      for (const l of lines) this.heard(parseDbwin(l));
    });
    child.stderr?.setEncoding('utf8').on('data', (d) => (errors += d));
    child.on('error', (e) => this.tell(`the debug-output reader couldn't start: ${e.message}`));
    child.on('close', (code) => {
      if (this.child !== child) return;
      this.child = null;
      if (this.subs.size) this.tell(`the debug-output reader stopped${code != null ? ` (exit ${code})` : ''}${errors.trim() ? `: ${errors.trim().split(/\r?\n/)[0]}` : ''}`);
    });
  }

  heard(entry) {
    if (!entry || entry.ready) return;
    if (entry.problem != null) return this.tell(problemNote(entry));
    for (const sub of this.subs) if (sub.wants(entry)) sub.line(entry);
  }

  tell(text) {
    this.problems.push(text);
    for (const sub of this.subs) sub.problem?.(text);
  }

  stop() {
    const child = this.child;
    this.child = null;
    this.problems = [];
    child?.kill();
  }
}

let shared = null;
/** Bosun's one DebugOutput. */
export const sharedDebugOutput = () => (shared ??= new DebugOutput());
