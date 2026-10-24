// CPU and memory: each platform's recorded output read, trees added up, the sampler's one look per
// sample, the sparklines and the memory alert; then the Crew view and /top with a stubbed sampler.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { KEYS, project, start, tempHome, type, until } from './helpers.js';
import { WINDOWS_SCRIPT, cpuBetween, createSampler, keepSample, memoryAlertLabel, memoryGrowing, nextMemoryAlert, parseProcStat, parseProcStatus, parsePs, parseWindowsPerf, shortBytes, sparkline, sumTrees, treeOf } from '../src/usage.js';
import { byUsage } from '../src/actions.js';
import { settingRows } from '../src/settings.js';
import { logTitle, usageSegments, withRoom } from '../src/ui/CrewView.jsx';

let cleanup;
before(() => (cleanup = tempHome()));
after(() => cleanup());

// Recorded on Linux: a shell (100), node under it (101), node's worker (102), and another tree.
const STAT = {
  100: '100 (sh) S 1 100 100 0 -1 4194560 120 0 0 0 1 1 0 0 20 0 1 0 5000 2400000 200 18446744073709551615',
  101: '101 (node) S 100 100 100 0 -1 4194560 9000 0 0 0 300 40 0 0 20 0 11 0 5001 1200000000 30000 18446744073709551615',
  102: '102 (node (worker) x) R 101 100 100 0 -1 4194560 100 0 0 0 50 10 0 0 20 0 1 0 5002 300000000 9000 18446744073709551615',
  200: '200 (bash) S 1 200 200 0 -1 4194560 120 0 0 0 7 3 0 0 20 0 1 0 6000 2400000 200 18446744073709551615',
};
const STATUS = (kb) => `Name:\tnode\nState:\tS (sleeping)\nVmPeak:\t  999999 kB\nVmRSS:\t   ${kb} kB\nThreads:\t11\n`;

test('Linux: /proc stat and status read, names with spaces and brackets too', () => {
  assert.deepEqual(parseProcStat(STAT[102]), { pid: 102, ppid: 101, ticks: 60 });
  assert.deepEqual(parseProcStat(STAT[101]), { pid: 101, ppid: 100, ticks: 340 });
  assert.equal(parseProcStat('garbage'), null);
  assert.equal(parseProcStatus(STATUS(2048)), 2048 * 1024);
  assert.equal(parseProcStatus('Name:\tkthreadd\n'), 0);
});

test('macOS ps and Windows PowerShell output read into the same rows', () => {
  const ps = '    1     0   0.0  12000\n  410     1  12.5 150000\n  411   410   3,5  20000\n  999     1   0.0    800\n';
  assert.deepEqual(parsePs(ps), [
    { pid: 1, ppid: 0, cpu: 0, mem: 12000 * 1024 },
    { pid: 410, ppid: 1, cpu: 12.5, mem: 150000 * 1024 },
    { pid: 411, ppid: 410, cpu: 3.5, mem: 20000 * 1024 },
    { pid: 999, ppid: 1, cpu: 0, mem: 800 * 1024 },
  ]);
  const win = JSON.stringify([
    { IDProcess: 0, CreatingProcessID: 0, PercentProcessorTime: 800, WorkingSetPrivate: 8192 },
    { IDProcess: 0, CreatingProcessID: 0, PercentProcessorTime: 100, WorkingSetPrivate: 1 },
    { IDProcess: 5120, CreatingProcessID: 400, PercentProcessorTime: 0, WorkingSetPrivate: 1048576 },
    { IDProcess: 5124, CreatingProcessID: 5120, PercentProcessorTime: 25, WorkingSetPrivate: 52428800 },
  ]);
  assert.deepEqual(parseWindowsPerf(win), [
    { pid: 5120, ppid: 400, cpu: 0, mem: 1048576 },
    { pid: 5124, ppid: 5120, cpu: 25, mem: 52428800 },
  ]);
  // One process comes as an object, not a list; nothing at all as nothing.
  assert.deepEqual(parseWindowsPerf('{"IDProcess":7,"CreatingProcessID":1,"PercentProcessorTime":5,"WorkingSetPrivate":10}'), [{ pid: 7, ppid: 1, cpu: 5, mem: 10 }]);
  assert.deepEqual(parseWindowsPerf(''), []);
  assert.match(WINDOWS_SCRIPT, /Win32_PerfFormattedData_PerfProc_Process/);
});

test('trees: a process and everything under it, added up; one gone has nothing', () => {
  const rows = parsePs('  410     1  12.5 150000\n  411   410   3.5  20000\n  412   411   1.0  1000\n  500     1   9.0  4000\n');
  assert.deepEqual([...treeOf(rows, 410)].sort(), [410, 411, 412]);
  assert.deepEqual([...treeOf(rows, 77)], []);
  const sums = sumTrees(rows, [410, 500, 77]);
  assert.deepEqual(sums.get(410), { cpu: 17, mem: 171000 * 1024 });
  assert.deepEqual(sums.get(500), { cpu: 9, mem: 4000 * 1024 });
  assert.deepEqual(sums.get(77), { cpu: 0, mem: 0 });
  assert.deepEqual([...cpuBetween(new Map([[1, 100]]), new Map([[1, 150], [2, 999]]), 1000, 100)], [[1, 50], [2, 0]]);
});

test('the sampler looks once per sample for every process, on each platform', async () => {
  // Linux: /proc read, the ticks between two samples made a CPU %.
  let ticks = { ...STAT };
  let clock = 0;
  const reads = [];
  const linux = createSampler({
    platform: 'linux',
    readdir: () => ['100', '101', '102', '200', 'self', 'meminfo'],
    readFile: (f) => {
      reads.push(f);
      const pid = f.split('/')[2];
      if (f.endsWith('/status')) return STATUS({ 100: 1000, 101: 50000, 102: 9000, 200: 3000 }[pid]);
      return ticks[pid];
    },
    now: () => clock,
    hz: 100,
  });
  const first = await linux.sample([100, 200]);
  assert.deepEqual(first.get(100), { cpu: 0, mem: 60000 * 1024 });
  assert.deepEqual(first.get(200), { cpu: 0, mem: 3000 * 1024 });
  assert.ok(!reads.some((f) => f.includes('self')), 'only the numbered folders');
  // Two seconds later node used 100 more ticks (half a core) and its worker 20.
  clock = 2000;
  ticks = { ...STAT, 101: STAT[101].replace(' 300 40 ', ' 400 40 '), 102: STAT[102].replace(' 50 10 ', ' 70 10 ') };
  const second = await linux.sample([100]);
  assert.equal(second.get(100).cpu, 60);
  // macOS: ps once, whatever the number of processes.
  const runs = [];
  const mac = createSampler({ platform: 'darwin', exec: async (file, args) => (runs.push([file, ...args]), '  410     1  12.5 150000\n  411   410   3.5  20000\n  500     1   9.0  4000\n') });
  const m = await mac.sample([410, 500]);
  assert.deepEqual(runs, [['ps', '-A', '-o', 'pid=,ppid=,%cpu=,rss=']]);
  assert.equal(m.get(410).cpu, 16);
  // Windows: PowerShell once.
  const winRuns = [];
  const win = createSampler({ platform: 'win32', exec: async (file, args) => (winRuns.push([file, ...args]), JSON.stringify([{ IDProcess: 9, CreatingProcessID: 1, PercentProcessorTime: 40, WorkingSetPrivate: 100 }, { IDProcess: 10, CreatingProcessID: 9, PercentProcessorTime: 2, WorkingSetPrivate: 50 }])) });
  assert.deepEqual((await win.sample([9])).get(9), { cpu: 42, mem: 150 });
  assert.equal(winRuns.length, 1);
  assert.equal(winRuns[0][0], 'powershell.exe');
  assert.equal(winRuns[0].at(-1), WINDOWS_SCRIPT);
  // A failing look is no numbers, not an error; nothing to look at is no look.
  const broken = createSampler({ platform: 'darwin', exec: async () => { throw new Error('no ps'); } });
  assert.equal((await broken.sample([1])).size, 0);
  assert.equal((await mac.sample([])).size, 0);
  assert.equal(runs.length, 1);
});

test('sparklines, sizes, the busiest first, and memory that keeps growing', () => {
  assert.equal(sparkline([0, 1, 2, 3, 4, 5, 6, 7]), '▁▂▃▄▅▆▇█');
  assert.equal(sparkline([0, 0, 0]), '▁▁▁');
  assert.equal(sparkline([1, 8, 1, 8], 2), '██');
  assert.equal(sparkline([]), '');
  assert.equal(shortBytes(512 * 1024), '512K');
  assert.equal(shortBytes(120 * 1024 * 1024), '120M');
  assert.equal(shortBytes(1.5 * 1024 ** 3), '1.5G');
  const procs = [{ name: 'b', usage: { cpu: 1, mem: 5 } }, { name: 'a', usage: null }, { name: 'c', usage: { cpu: 40, mem: 1 } }, { name: 'd', usage: { cpu: 1, mem: 9 } }];
  assert.deepEqual(byUsage(procs).map((p) => p.name), ['c', 'd', 'b', 'a']);
  const MB = 1024 * 1024;
  const rising = Array.from({ length: 12 }, (_, i) => ({ cpu: 1, mem: (400 + i * 20) * MB }));
  assert.equal(memoryGrowing(rising, 500 * MB), true);
  assert.equal(memoryGrowing(rising, 1024 * MB), false, 'not past the limit');
  assert.equal(memoryGrowing(rising.slice(-5), 500 * MB), false, 'too soon to say');
  assert.equal(memoryGrowing(Array.from({ length: 12 }, () => ({ mem: 900 * MB })), 500 * MB), false, 'big but steady');
  assert.equal(memoryGrowing(rising, null), false, 'off');
  assert.deepEqual([null, 512, 1024, 2048, 4096].map(nextMemoryAlert), [512, 1024, 2048, 4096, null]);
  assert.equal(memoryAlertLabel(2048), '2 GB');
  const row = settingRows({ memoryAlert: 1024 }).find((r) => r.id === 'memoryAlert');
  assert.equal(row.value, '1 GB');
  assert.equal(settingRows({}).find((r) => r.id === 'memoryAlert').value, 'off');
  const p = { name: 'api', child: {}, usage: null };
  for (let i = 0; i < 40; i++) keepSample(p, { cpu: i, mem: 100 * MB });
  assert.equal(p.samples.length, 30);
  assert.equal(p.samples[0].cpu, 10);
  assert.match(logTitle(p, 5), /^api · 39% \S{5} · 100M \S{5}$/);
  assert.equal(logTitle({ ...p, child: null }), 'api');
  assert.equal(usageSegments(p)[0].text, '  39%  100M');
  assert.deepEqual(withRoom([{ text: 'abc' }], [[[{ text: 'de' }]], [[{ text: 'fghij' }]]], 6).map((s) => s.text), ['abc', 'de']);
});

const TICKER = `setInterval(() => console.log('tick'), 200);`;

test('the Crew view shows each process\'s CPU and memory, /top lists them busiest first, and growing memory is said once', async () => {
  const dir = project({ procs: { api: 'node ticker.js', web: 'node ticker.js' } }, { 'ticker.js': TICKER });
  const MB = 1024 * 1024;
  let n = 0;
  const looks = [];
  const sampleUsage = async (pids) => {
    looks.push(pids);
    n++;
    return new Map(pids.map((pid, i) => [pid, i === 0 ? { cpu: 12, mem: (300 + n * 40) * MB } : { cpu: 55, mem: 80 * MB }]));
  };
  const notes = [];
  const app = start({ dir, sampleUsage, sampleEvery: 60, config: { history: [], memoryAlert: 512 }, notify: (title, body) => notes.push({ title, body }) });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => /api · 12% \S+ · \d+M/.test(frame()), 'the api\'s CPU and memory in its log\'s title');
    assert.ok(looks.every((pids) => pids.length <= 2), 'one look for every process');
    await until(() => notes.some((x) => /api's memory keeps growing/.test(x.title)), 'the memory alert');
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(notes.filter((x) => /memory/.test(x.title)).length, 1, 'said once');
    assert.match(frame(), /api's memory keeps growing/);
    app.stdin.write(':');
    await type(app.stdin, 'top');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Top') && /web\s+55%[\s\S]*api\s+12%/.test(frame()), 'top, the busiest first');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('tick') && frame().includes('node ticker.js'), 'its log, from top');
    app.stdin.write(KEYS.esc);
    await until(() => frame().includes('╭─ Top'), 'back to top');
    app.stdin.write(KEYS.esc);
  } finally {
    app.stdin.write('q');
    app.unmount();
  }
});
