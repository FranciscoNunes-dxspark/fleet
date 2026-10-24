// CPU and memory per process, its children included: sampled every 2 seconds while the Crew view
// shows. One look at the machine per sample for every process (Linux reads /proc, macOS runs ps once,
// Windows runs PowerShell once), never one per process. The parsers, the trees, the sums, the
// sparklines and the rule for memory that keeps growing are pure; `createSampler` takes the file
// reads and the program runner, so the tests feed it each platform's recorded output.
import { execFile } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';

/** How many samples are kept: a minute's, at one every 2 seconds. */
export const KEEP_SAMPLES = 30;
export const SAMPLE_EVERY = 2000;

/**
 * Linux's /proc/<pid>/stat: { pid, ppid, ticks } (user and system time, in clock ticks). The name in
 * brackets can hold spaces and brackets of its own, so the fields are counted from the last `)`.
 */
export function parseProcStat(text) {
  const s = String(text);
  const close = s.lastIndexOf(')');
  if (close < 0) return null;
  const pid = Number.parseInt(s, 10);
  const f = s.slice(close + 2).trim().split(/\s+/);
  // f[0] is the state (field 3), so field n is f[n - 3].
  const ppid = Number(f[1]);
  const ticks = Number(f[11]) + Number(f[12]);
  if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !Number.isFinite(ticks)) return null;
  return { pid, ppid, ticks };
}

/** The resident memory in /proc/<pid>/status (VmRSS), in bytes; 0 for a process without (a zombie, a kernel thread). */
export function parseProcStatus(text) {
  const m = /^VmRSS:\s+(\d+)\s*kB/m.exec(String(text));
  return m ? Number(m[1]) * 1024 : 0;
}

/** macOS's `ps -A -o pid=,ppid=,%cpu=,rss=`: [{ pid, ppid, cpu, mem }], rss in KB made bytes. */
export function parsePs(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+([\d.,]+)\s+(\d+)\s*$/.exec(line);
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), cpu: Number(m[3].replace(',', '.')), mem: Number(m[4]) * 1024 });
  }
  return out;
}

/** The PowerShell line Windows runs per sample: every process's id, parent, CPU % and private working set, as JSON. */
export const WINDOWS_SCRIPT =
  'Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Select-Object IDProcess,CreatingProcessID,PercentProcessorTime,WorkingSetPrivate | ConvertTo-Json -Compress';

/** That JSON (one object or a list): [{ pid, ppid, cpu, mem }], without _Total and Idle (pid 0). */
export function parseWindowsPerf(text) {
  let data;
  try {
    data = JSON.parse(String(text).trim() || '[]');
  } catch {
    return [];
  }
  const out = [];
  for (const r of Array.isArray(data) ? data : [data]) {
    const pid = Number(r?.IDProcess);
    if (!pid) continue;
    out.push({ pid, ppid: Number(r.CreatingProcessID) || 0, cpu: Number(r.PercentProcessorTime) || 0, mem: Number(r.WorkingSetPrivate) || 0 });
  }
  return out;
}

/** The pids in the tree under `root` (itself included when it's there), from rows with { pid, ppid }. */
export function treeOf(rows, root) {
  const kids = new Map();
  for (const r of rows) {
    if (r.pid === r.ppid) continue;
    if (!kids.has(r.ppid)) kids.set(r.ppid, []);
    kids.get(r.ppid).push(r.pid);
  }
  const seen = new Set();
  const todo = [root];
  while (todo.length) {
    const pid = todo.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    todo.push(...(kids.get(pid) ?? []));
  }
  if (!rows.some((r) => r.pid === root)) seen.delete(root);
  return seen;
}

/** Each root's tree added up: Map root → { cpu, mem }, from rows with { pid, ppid, cpu, mem }. */
export function sumTrees(rows, roots) {
  const by = new Map(rows.map((r) => [r.pid, r]));
  const out = new Map();
  for (const root of roots) {
    let cpu = 0;
    let mem = 0;
    for (const pid of treeOf(rows, root)) {
      cpu += by.get(pid)?.cpu ?? 0;
      mem += by.get(pid)?.mem ?? 0;
    }
    out.set(root, { cpu: Math.round(cpu * 10) / 10, mem });
  }
  return out;
}

/**
 * The CPU % of each pid between two Linux samples: its ticks since the last one over the ticks that
 * passed (`ms` at `hz` a second), as % of one core. A pid new since then counts from this sample.
 */
export function cpuBetween(before, now, ms, hz = 100) {
  const out = new Map();
  const ticks = (ms / 1000) * hz;
  for (const [pid, t] of now) {
    const was = before?.get(pid);
    out.set(pid, was == null || ticks <= 0 ? 0 : Math.max(0, ((t - was) / ticks) * 100));
  }
  return out;
}

const run = (file, args) =>
  new Promise((done, fail) =>
    execFile(file, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 10_000 }, (e, stdout) => (e ? fail(e) : done(stdout))),
  );

/**
 * A sampler: `sample(roots)` resolves Map root pid → { cpu, mem } for the processes' trees, one look
 * at the machine for all of them. `platform`, `readFile`, `readdir`, `exec(file, args)`, `now` and
 * `hz` are the tests' to set. A look that fails resolves an empty map.
 */
export function createSampler({ platform = process.platform, readFile = (f) => readFileSync(f, 'utf8'), readdir = readdirSync, exec = run, now = Date.now, hz = 100 } = {}) {
  let last = null;
  const linux = (roots) => {
    const rows = [];
    for (const name of readdir('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const r = parseProcStat(readFile(`/proc/${name}/stat`));
        if (r) rows.push(r);
      } catch {
        // Gone between the listing and the read.
      }
    }
    const at = now();
    const ticks = new Map(rows.map((r) => [r.pid, r.ticks]));
    const cpu = cpuBetween(last?.ticks, ticks, last ? at - last.at : 0, hz);
    last = { at, ticks };
    const wanted = new Set(roots.flatMap((root) => [...treeOf(rows, root)]));
    const full = rows.map((r) => {
      let mem = 0;
      if (wanted.has(r.pid)) {
        try {
          mem = parseProcStatus(readFile(`/proc/${r.pid}/status`));
        } catch {
          // Gone meanwhile.
        }
      }
      return { ...r, cpu: cpu.get(r.pid) ?? 0, mem };
    });
    return sumTrees(full, roots);
  };
  return {
    async sample(roots) {
      if (!roots.length) return new Map();
      try {
        if (platform === 'linux') return linux(roots);
        if (platform === 'win32') return sumTrees(parseWindowsPerf(await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_SCRIPT])), roots);
        return sumTrees(parsePs(await exec('ps', ['-A', '-o', 'pid=,ppid=,%cpu=,rss='])), roots);
      } catch {
        return new Map();
      }
    },
  };
}

/** A process's sample kept: `usage` the latest, `samples` the last KEEP_SAMPLES of them. */
export function keepSample(p, sample) {
  p.usage = sample;
  p.samples = [...(p.samples ?? []), sample].slice(-KEEP_SAMPLES);
}

const BARS = '▁▂▃▄▅▆▇█';

/** `values` as a line of `width` bars (the newest at the right; a bar each, or the most of each stretch), scaled to their own top. */
export function sparkline(values, width = values.length) {
  if (!values.length || width <= 0) return '';
  const n = Math.min(width, values.length);
  const per = values.length / n;
  const cols = Array.from({ length: n }, (_, i) => Math.max(...values.slice(Math.floor(i * per), Math.max(Math.floor(i * per) + 1, Math.floor((i + 1) * per)))));
  const top = Math.max(...cols);
  return cols.map((v) => (top > 0 ? BARS[Math.min(7, Math.round((v / top) * 7))] : BARS[0])).join('');
}

/** Memory as the list says it: 820K, 120M, 1.4G. */
export function shortBytes(n) {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)}G`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)}M`;
  return `${Math.max(0, Math.round(n / 1024))}K`;
}

/** CPU as the list says it: 0%, 3%, 140%. */
export const shortCpu = (cpu) => `${Math.round(cpu)}%`;

/** The memory alert's choices, in MB, as ↵ in the settings goes round them (null: off). */
export const MEMORY_ALERTS = [null, 512, 1024, 2048, 4096];
export const nextMemoryAlert = (mb) => MEMORY_ALERTS[(MEMORY_ALERTS.indexOf(mb ?? null) + 1) % MEMORY_ALERTS.length];
export const memoryAlertLabel = (mb) => (mb ? (mb >= 1024 ? `${mb / 1024} GB` : `${mb} MB`) : 'off');

/**
 * Whether memory keeps growing past `limit` bytes: the newest sample over it, and over the last
 * `samples` (at least 10 of them, 20 seconds) it rose by a tenth or more, most steps up or level.
 */
export function memoryGrowing(samples, limit) {
  if (!limit || samples.length < 10) return false;
  const mem = samples.map((s) => s.mem);
  const last = mem.at(-1);
  if (last <= limit || last < mem[0] * 1.1) return false;
  let up = 0;
  for (let i = 1; i < mem.length; i++) if (mem[i] >= mem[i - 1]) up++;
  return up >= (mem.length - 1) * 0.7;
}
