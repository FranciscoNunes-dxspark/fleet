// A server's health (/health): one ssh command that prints disk use, memory, load, CPUs, uptime, the
// busiest processes and the failed systemd units, each part under a marker line, and the pure parse of
// what it printed. What a server prints is untrusted: names are cleaned (format.js plainText) here.
import { plainText } from './format.js';

// Each part's fallbacks where the first tool may be missing (a container's busybox, an old distribution).
export const HEALTH_COMMAND = [
  "echo '@@df'",
  'df -P -k 2>/dev/null',
  "echo '@@mem'",
  'cat /proc/meminfo 2>/dev/null || free -m 2>/dev/null',
  "echo '@@load'",
  'cat /proc/loadavg 2>/dev/null || uptime',
  "echo '@@cpus'",
  'nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null',
  "echo '@@uptime'",
  'cat /proc/uptime 2>/dev/null',
  "echo '@@topcpu'",
  'ps -eo pid=,pcpu=,pmem=,comm= --sort=-pcpu 2>/dev/null | head -n 5',
  "echo '@@topmem'",
  'ps -eo pid=,pcpu=,pmem=,comm= --sort=-pmem 2>/dev/null | head -n 5',
  "echo '@@units'",
  "if command -v systemctl >/dev/null 2>&1; then systemctl list-units --state=failed --no-legend --plain 2>/dev/null; else echo '@@nosystemd'; fi",
  "echo '@@end'",
].join('; ');

/** A disk this full is worth a word. */
export const DISK_FULL = 90;

// File systems that aren't disks: memory, snaps' images, containers' layers.
const NOT_A_DISK = /^(tmpfs|devtmpfs|udev|squashfs|overlay|none|efivarfs|shm)$/;
const NOT_A_MOUNT = /^\/(snap|run|dev|sys|proc)(\/|$)/;

function sections(text) {
  const out = {};
  let at = null;
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    const m = /^@@(\w+)$/.exec(line.trim());
    if (m) {
      at = m[1];
      out[at] ??= [];
    } else if (at) out[at].push(line);
  }
  return out;
}

const procs = (lines = []) =>
  lines
    .map((l) => /^\s*(\d+)\s+([\d.]+)\s+([\d.]+)\s+(.+)$/.exec(l))
    .filter(Boolean)
    .slice(0, 5)
    .map((m) => ({ pid: Number(m[1]), cpu: Number(m[2]), mem: Number(m[3]), command: plainText(m[4]).trim() }));

function memoryOf(lines = []) {
  const kb = {};
  for (const l of lines) {
    const m = /^(\w+):\s+(\d+)\s*kB/i.exec(l.trim());
    if (m) kb[m[1]] = Number(m[2]);
    // free -m's lines, where /proc/meminfo isn't there.
    const f = /^(Mem|Swap):\s+(\d+)\s+(\d+)\s+(\d+)(?:\s+\d+\s+\d+\s+(\d+))?/.exec(l.trim());
    if (f) kb[`free${f[1]}`] = { total: Number(f[2]), used: Number(f[3]), available: f[5] != null ? Number(f[5]) : Number(f[4]) };
  }
  if (kb.MemTotal) {
    const available = kb.MemAvailable ?? (kb.MemFree ?? 0) + (kb.Buffers ?? 0) + (kb.Cached ?? 0);
    return { totalMb: Math.round(kb.MemTotal / 1024), availableMb: Math.round(available / 1024), usedMb: Math.round((kb.MemTotal - available) / 1024), swapTotalMb: Math.round((kb.SwapTotal ?? 0) / 1024), swapUsedMb: Math.round(((kb.SwapTotal ?? 0) - (kb.SwapFree ?? 0)) / 1024) };
  }
  if (kb.freeMem) return { totalMb: kb.freeMem.total, availableMb: kb.freeMem.available, usedMb: kb.freeMem.total - kb.freeMem.available, swapTotalMb: kb.freeSwap?.total ?? 0, swapUsedMb: kb.freeSwap?.used ?? 0 };
  return null;
}

/**
 * What HEALTH_COMMAND printed: { disks: [{ fs, sizeKb, usedKb, availKb, percent, mount }], memory:
 * { totalMb, usedMb, availableMb, swapTotalMb, swapUsedMb } | null, load: [1, 5, 15] | null, cpus,
 * uptime (seconds) | null, topCpu, topMem: [{ pid, cpu, mem, command }], failed: [{ unit, description }]
 * | null (null: no systemd) }.
 */
export function parseHealth(text) {
  const s = sections(text);
  const disks = (s.df ?? [])
    .map((l) => l.trim().split(/\s+/))
    .filter((w) => w.length >= 6 && /^\d+%$/.test(w[4]))
    .map((w) => ({ fs: plainText(w[0]), sizeKb: Number(w[1]), usedKb: Number(w[2]), availKb: Number(w[3]), percent: Number(w[4].slice(0, -1)), mount: plainText(w.slice(5).join(' ')) }))
    .filter((d) => !NOT_A_DISK.test(d.fs) && !NOT_A_MOUNT.test(d.mount) && d.sizeKb > 0);
  const loadText = (s.load ?? []).join(' ');
  const lm = /^\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(loadText) ?? /load averages?:\s*([\d.]+),?\s+([\d.]+),?\s+([\d.]+)/.exec(loadText);
  const cpus = Number((s.cpus ?? []).find((l) => /^\s*\d+\s*$/.test(l))) || null;
  const up = Number.parseFloat((s.uptime ?? [])[0]);
  const failed = s.nosystemd || (s.units ?? []).some((l) => l.trim() === '@@nosystemd') ? null : (s.units ?? []).map((l) => l.trim()).filter(Boolean).map((l) => {
    const w = l.replace(/^[●*]\s*/, '').split(/\s+/);
    return { unit: plainText(w[0]), description: plainText(w.slice(4).join(' ')) };
  });
  return {
    disks,
    memory: memoryOf(s.mem),
    load: lm ? [Number(lm[1]), Number(lm[2]), Number(lm[3])] : null,
    cpus,
    uptime: Number.isFinite(up) ? up : null,
    topCpu: procs(s.topcpu),
    topMem: procs(s.topmem),
    failed,
  };
}

/** What is wrong, as short phrases (for the panel's red and the mood's reason): full disks and failed units. */
export function healthProblems(h) {
  if (!h) return [];
  const out = h.disks.filter((d) => d.percent > DISK_FULL).map((d) => `${d.mount} is ${d.percent}% full`);
  if (h.failed?.length) out.push(`${h.failed.length === 1 ? h.failed[0].unit : `${h.failed.length} units`} failed`);
  return out;
}

/** Seconds as "41 days, 3h", "5h 12m", "7m". */
export function uptimeText(seconds) {
  if (seconds == null) return '';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d) return `${d} day${d === 1 ? '' : 's'}, ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}
