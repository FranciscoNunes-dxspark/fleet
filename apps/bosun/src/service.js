// Windows services as crew processes (bosun.json's "service"): SQL Server Express, MSMQ, a TopShelf
// service of the project's own. Windows' service manager runs them, so Bosun starts, watches and stops
// them through `sc`, as it drives IIS sites through appcmd: `ServiceChild` looks to the supervisor like
// a child process, with the service's process as its pid and the event log's entries for it in its
// log. The parsers are pure; `serviceControl` runs sc and PowerShell (injectable).
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { execFile, spawnSync } from 'node:child_process';
import { eventJson, parseEvents } from './iis.js';

/** bosun.json's "service": a service's name (its short one, as `sc query` takes it), or null. */
export const serviceSpec = (v) => (typeof v === 'string' && v.trim() && !/["\r\n]/.test(v) ? v.trim() : null);

/** `sc queryex <name>`: { name, state (RUNNING, STOPPED, START_PENDING…), pid, exitCode, serviceExitCode }, or null. */
export function parseScQuery(text) {
  const t = String(text ?? '');
  const name = /SERVICE_NAME:\s*(\S.*?)\s*$/im.exec(t)?.[1];
  const state = /STATE\s*:\s*\d+\s+(\w+)/i.exec(t)?.[1];
  if (!name || !state) return null;
  const num = (re) => {
    const v = re.exec(t)?.[1];
    return v != null ? Number(v) : null;
  };
  return { name, state: state.toUpperCase(), pid: num(/\bPID\s*:\s*(\d+)/i) || null, exitCode: num(/WIN32_EXIT_CODE\s*:\s*(\d+)/i), serviceExitCode: num(/SERVICE_EXIT_CODE\s*:\s*(\d+)/i) };
}

/** `sc qc <name>`: { displayName, startType (DEMAND_START, AUTO_START, DISABLED…), binary }. */
export function parseScConfig(text) {
  const t = String(text ?? '');
  const field = (name) => new RegExp(`^\\s*${name}\\s*:\\s*(?:\\d+\\s+)?(.*?)\\s*$`, 'im').exec(t)?.[1] ?? null;
  return { displayName: field('DISPLAY_NAME'), startType: field('START_TYPE'), binary: field('BINARY_PATH_NAME') };
}

/** The message for an sc that failed, from its error number. */
export function scProblem(e) {
  const said = String(e?.stdout || e?.message || '');
  const code = Number(/FAILED (\d+)/.exec(said)?.[1] ?? e?.code);
  if (e?.code === 'ENOENT') return "sc isn't here: Windows services are Windows' only";
  if (code === 1060) return "there's no such service on this machine (sc query lists them)";
  if (code === 5) return 'starting and stopping a service needs an administrator: start the terminal as administrator (or run Bosun through gsudo)';
  if (code === 1058) return "it's disabled: sc config <name> start= demand turns it back on";
  return said.trim().split(/\r?\n/).filter(Boolean).pop() ?? 'sc failed';
}

const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** The PowerShell that lists the event log's entries since `since` (ms) from the service itself, or from the service manager about it. */
export function serviceEventsScript(since, name, displayName) {
  const at = new Date(since).toISOString();
  const about = displayName ? ` -or ($_.ProviderName -eq 'Service Control Manager' -and $_.Message -like ${quote(`*${displayName}*`)})` : '';
  return `Get-WinEvent -FilterHashtable @{LogName='Application','System'; StartTime=[datetime]::Parse('${at}').ToLocalTime()} -ErrorAction SilentlyContinue | Where-Object { $_.ProviderName -eq ${quote(name)}${about} } | Select-Object TimeCreated,Id,Level,ProviderName,Message | ConvertTo-Json -Compress`;
}

const execText = (file, args, opts = {}) =>
  new Promise((done, fail) =>
    execFile(file, args, { windowsHide: true, timeout: 30_000, maxBuffer: 8 * 1024 * 1024, ...opts }, (e, stdout, stderr) => {
      if (e) return fail(Object.assign(e, { stdout: String(stdout || stderr || '') }));
      done(String(stdout));
    }),
  );

/** Windows services through sc: `exec(args)`, `execSync(args)`, `powershell(script)` injectable. */
export function serviceControl({ exec = (args) => execText('sc.exe', args), execSync = (args) => spawnSync('sc.exe', args, { windowsHide: true, stdio: 'ignore', timeout: 20_000 }), powershell = (script) => execText('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]) } = {}) {
  return {
    /** Its state and process, or null when there's no such service. */
    async query(name) {
      try {
        return parseScQuery(await exec(['queryex', name]));
      } catch (e) {
        if (/1060/.test(e.stdout ?? '')) return null;
        throw e;
      }
    },
    async config(name) {
      return parseScConfig(await exec(['qc', name]));
    },
    start: (name) => exec(['start', name]).catch((e) => (/1056/.test(e.stdout ?? '') ? '' : Promise.reject(e))),
    stop: (name) => exec(['stop', name]).catch((e) => (/1062/.test(e.stdout ?? '') ? '' : Promise.reject(e))),
    stopNow: (name) => execSync(['stop', name]),
    async events(since, name, displayName) {
      return parseEvents(await powershell(serviceEventsScript(since, name, displayName)));
    },
  };
}

/**
 * A Windows service, looking to the supervisor like a spawned child: started (or adopted when it was
 * running), its process as `pid` ('pid' when it changes), 'close' when it stops, by itself (crashed,
 * with its exit code) or by `stop()`. `stopNow()` stops one Bosun started, at once.
 */
export class ServiceChild extends EventEmitter {
  constructor(name, { control, every = 2000, eventsEvery = 10_000, wait = 60_000, now = Date.now }) {
    super();
    Object.assign(this, { name, control, every, eventsEvery, wait, now });
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.pid = null;
    this.timers = [];
    setImmediate(() => this.begin());
  }

  say(text) {
    if (!this.closed) this.stdout.write(`${text}\n`);
  }

  warn(text) {
    if (!this.closed) this.stderr.write(`${text}\n`);
  }

  async begin() {
    try {
      const q = await this.control.query(this.name);
      if (!q) throw Object.assign(new Error(), { stdout: 'FAILED 1060' });
      this.config = await this.control.config(this.name).catch(() => ({}));
      this.adopted = q.state === 'RUNNING';
      if (this.adopted) this.say(`── ${this.label()} was already running: Bosun leaves it running when it quits`);
      else {
        if (this.config.startType === 'DISABLED') throw Object.assign(new Error(), { stdout: 'FAILED 1058' });
        await this.control.start(this.name);
        const up = await this.until((s) => s.state === 'RUNNING' || s.state === 'STOPPED');
        if (up?.state !== 'RUNNING') {
          this.warn(`── ${this.label()} didn't start${up ? ` (exit ${up.serviceExitCode || up.exitCode})` : ''}: the event log's lines say why`);
          await this.pollEvents();
          return this.end(up?.exitCode || 1);
        }
        this.say(`── started ${this.label()}`);
      }
      if (this.stopping) {
        this.stopping = false;
        this.started = true;
        return this.stop();
      }
      this.started = true;
      this.emit('spawn');
      this.eventsSince = this.now() - 5000;
      await this.poll();
      this.timers.push(setInterval(() => this.poll(), this.every));
      this.timers.push(setInterval(() => this.pollEvents(), this.eventsEvery));
    } catch (e) {
      this.warn(`── ${this.name}: ${scProblem(e)}`);
      this.end(1);
    }
  }

  label() {
    return this.config?.displayName && this.config.displayName !== this.name ? `${this.config.displayName} (${this.name})` : this.name;
  }

  /** Looks at it until `done(state)` says so, or the wait is over; resolves the last state (null: gone). */
  async until(done) {
    const end = this.now() + this.wait;
    for (;;) {
      const q = await this.control.query(this.name).catch(() => null);
      if (!q || done(q) || this.now() >= end) return q;
      await new Promise((r) => setTimeout(r, Math.min(500, this.every)));
    }
  }

  async poll() {
    if (this.closed || this.stopping || this.polling) return;
    this.polling = true;
    try {
      const q = await this.control.query(this.name);
      if (this.closed || this.stopping) return;
      if (!q || q.state === 'STOPPED') {
        const code = q ? q.serviceExitCode || q.exitCode : null;
        this.warn(`── ${this.label()} stopped by itself${code ? ` (exit ${code})` : ''}`);
        await this.pollEvents();
        return this.end(code || 1);
      }
      if (q.pid !== this.pid) {
        if (this.pid && q.pid) this.say(`── its process changed: ${this.pid} → ${q.pid}`);
        this.pid = q.pid;
        this.emit('pid', q.pid);
      }
    } catch {
      // One look that failed: the next one says.
    } finally {
      this.polling = false;
    }
  }

  async pollEvents() {
    if (this.closed || this.eventsBusy || this.eventsSince == null) return;
    this.eventsBusy = true;
    try {
      const events = await this.control.events(this.eventsSince, this.name, this.config?.displayName);
      for (const e of events.filter((x) => x.time == null || x.time > this.eventsSince).sort((a, b) => (a.time ?? 0) - (b.time ?? 0))) {
        if (e.time) this.eventsSince = Math.max(this.eventsSince, e.time);
        this.say(eventJson(e));
      }
    } catch {
      // PowerShell couldn't say this time.
    } finally {
      this.eventsBusy = false;
    }
  }

  /** s and q: stops it, and closes once it has stopped (or the wait is over). */
  async stop() {
    if (this.closed || this.stopping) return;
    this.stopping = true;
    if (!this.started) return;
    try {
      await this.control.stop(this.name);
      const q = await this.until((s) => s.state === 'STOPPED');
      if (q && q.state !== 'STOPPED') this.warn(`── ${this.label()} is still ${q.state.toLowerCase().replace(/_/g, ' ')}`);
    } catch (e) {
      this.warn(`── couldn't stop it: ${scProblem(e)}`);
    }
    this.end(null);
  }

  /** Bosun exiting: stops it when Bosun started it. */
  stopNow() {
    if (this.closed) return;
    if (this.started && !this.adopted) {
      try {
        this.control.stopNow(this.name);
      } catch {
        // Exiting all the same.
      }
    }
    this.end(null);
  }

  end(code) {
    if (this.closed) return;
    for (const t of this.timers) clearInterval(t);
    this.closed = true;
    this.stdout.end();
    this.stderr.end();
    this.pid = null;
    setImmediate(() => this.emit('close', code, null));
  }
}
