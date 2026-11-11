// /backup and /restore, pure: what's refused, the SQL Server statements (the backup is a file on the
// server, in its default backup folder unless a path says otherwise) and the pg_dump / pg_restore
// and mysqldump / mysql command lines, whose password goes in the child's environment only
// (PGPASSWORD, MYSQL_PWD), never on the command line.
import { serverHost } from './azure.js';
import { hostPort, isReadOnly } from './connections.js';

export const AZURE_SQL_NOTE =
  "Azure SQL Database has no BACKUP to a file: it keeps backups of its own (restore to a point in time from the portal). For a copy to take elsewhere, export a .bacpac: the database's Export in the Azure portal, or SqlPackage /Action:Export.";

/** Whether a server is Azure SQL Database's (myserver.database.windows.net and the other clouds'). */
export const isAzureSqlDatabase = (conn) => /\.database\.(windows\.net|azure\.com|chinacloudapi\.cn|usgovcloudapi\.net|cloudapi\.de)$/i.test(serverHost(conn?.server ?? ''));

/** Why /backup or /restore won't run on `conn` (production, read-only, Azure SQL, a tunnel the tools can't use), or null. */
export function backupRefusal(conn, kind = 'sqlserver') {
  if (conn.prod) return `${conn.name} is production: /backup and /restore only work on a connection that is neither production nor read-only, such as a dev database.`;
  if (isReadOnly(conn)) return `${conn.name} is read-only: /backup and /restore only work on a connection that is neither production nor read-only, such as a dev database.`;
  if (kind === 'sqlserver' && isAzureSqlDatabase(conn)) return AZURE_SQL_NOTE;
  if (kind !== 'sqlserver' && conn.ssh) return `${conn.name} goes through an SSH tunnel, which ${kind === 'postgres' ? 'pg_dump' : 'mysqldump'} can't use: run it on ${conn.ssh} instead.`;
  return null;
}

/** "20261024-153012", for file names (UTC). */
export const stamp = (now = new Date()) => now.toISOString().slice(0, 19).replace(/-|:/g, '').replace('T', '-');

/** A name safe in a file name on any system. */
export const fileSafe = (s) => String(s).replace(/[^\w.-]+/g, '_');

// ---------------------------------------------------------------------------------------------------
// SQL Server: the file is on the server, so its paths are the server's (Windows or Linux).

export const BACKUP_INFO_SQL = `-- trawl:backup-info
SELECT CAST(SERVERPROPERTY('InstanceDefaultBackupPath') AS nvarchar(4000)) AS backup_path,
  CAST(SERVERPROPERTY('InstanceDefaultDataPath') AS nvarchar(4000)) AS data_path,
  CAST(SERVERPROPERTY('InstanceDefaultLogPath') AS nvarchar(4000)) AS log_path,
  CAST(SERVERPROPERTY('EngineEdition') AS int) AS engine_edition,
  CAST(SERVERPROPERTY('MachineName') AS nvarchar(256)) AS machine;`;

const windowsPath = (p) => /^[A-Za-z]:|\\/.test(p);
/** Whether a path on the server is a whole one (C:\…, \\share\…, /var/…). */
export const absoluteOnServer = (p) => /^([A-Za-z]:[\\/]|\\\\|\/)/.test(p);
/** A folder and a name joined the server's way. */
export function serverJoin(dir, name) {
  const sep = windowsPath(dir) ? '\\' : '/';
  return `${String(dir).replace(/[\\/]+$/, '')}${sep}${name}`;
}
const folderOf = (p) => String(p).replace(/[\\/][^\\/]*$/, '');

/** Where a backup goes on the server: the path given when it's a whole one, else in the default backup folder. */
export function backupPath(info, database, file, now = new Date()) {
  if (file && absoluteOnServer(file)) return file;
  if (!info.backup_path) return null;
  return serverJoin(info.backup_path, file || `${fileSafe(database)}-${stamp(now)}.bak`);
}

const nstring = (s) => `N'${String(s).replace(/'/g, "''")}'`;
const bracket = (s) => `[${String(s).replace(/]/g, ']]')}]`;

export const backupSql = (database, path) => `BACKUP DATABASE ${bracket(database)} TO DISK = ${nstring(path)} WITH COPY_ONLY, INIT, STATS = 10;`;
export const restoreHeaderSql = (path) => `-- trawl:restore-header\nRESTORE HEADERONLY FROM DISK = ${nstring(path)};`;
export const restoreFilesSql = (path) => `-- trawl:restore-files\nRESTORE FILELISTONLY FROM DISK = ${nstring(path)};`;

/**
 * The backup's files moved to the target's own names in the server's default data and log folders
 * (or beside where they were): [{ logical, to }]. Restoring under another name would otherwise
 * collide with the original's files.
 */
export function restoreMoves(files, target, info) {
  const counts = { D: 0, L: 0, F: 0 };
  return files.map((f) => {
    const type = String(f.Type ?? 'D').toUpperCase();
    const n = counts[type] = (counts[type] ?? 0) + 1;
    const dir = (type === 'L' ? info.log_path : info.data_path) || folderOf(f.PhysicalName);
    const name = type === 'L' ? `${fileSafe(target)}_log${n > 1 ? n : ''}.ldf` : type === 'F' ? `${fileSafe(target)}_fs${n}` : n === 1 ? `${fileSafe(target)}.mdf` : `${fileSafe(target)}_${n}.ndf`;
    return { logical: f.LogicalName, to: serverJoin(dir, name) };
  });
}

/** RESTORE DATABASE from `path` as `target`, from master; over one that's there, its other sessions are put out first. */
export function restoreSql({ target, path, moves, replace }) {
  const lines = ['USE master;'];
  if (replace) lines.push(`ALTER DATABASE ${bracket(target)} SET SINGLE_USER WITH ROLLBACK IMMEDIATE;`);
  const withs = [...moves.map((m) => `MOVE ${nstring(m.logical)} TO ${nstring(m.to)}`), ...(replace ? ['REPLACE'] : []), 'RECOVERY', 'STATS = 10'];
  lines.push(`RESTORE DATABASE ${bracket(target)} FROM DISK = ${nstring(path)}\n  WITH ${withs.join(',\n    ')};`);
  return lines.join('\n');
}

export const multiUserSql = (target) => `ALTER DATABASE ${bracket(target)} SET MULTI_USER;`;

// ---------------------------------------------------------------------------------------------------
// PostgreSQL and MySQL, through their own tools on this machine.

/** An argument quoted for the shell run.js starts (cmd.exe on Windows, sh elsewhere). */
export function shellArg(s, platform = process.platform) {
  const v = String(s);
  if (platform === 'win32') return /^[\w.:\\/@=-]+$/.test(v) ? v : `"${v.replace(/"/g, '""')}"`;
  return /^[\w.:/@=-]+$/.test(v) ? v : `'${v.replace(/'/g, "'\\''")}'`;
}

const TOOLS = { postgres: { dump: 'pg_dump', load: 'pg_restore', ext: 'dump', from: "PostgreSQL's client tools" }, mysql: { dump: 'mysqldump', load: 'mysql', ext: 'sql', from: "MySQL's (or MariaDB's) client" } };
export const toolsFor = (kind) => TOOLS[kind];

function where(conn, kind) {
  const { host, port } = hostPort(conn.server, kind === 'postgres' ? 5432 : 3306);
  return { host, port };
}

/** The environment the tool gets the password (and TLS) from; nothing of it is on the command line. */
export function toolEnv(conn, kind, password) {
  if (kind === 'postgres') return { ...(password != null ? { PGPASSWORD: password } : {}), ...(conn.ssl || conn.trustCert ? { PGSSLMODE: 'require' } : {}) };
  return password != null ? { MYSQL_PWD: password } : {};
}

/** The dump: { command, env }. Postgres's custom format (-Fc), which pg_restore reads; MySQL's SQL, routines and triggers too. */
export function dumpCommand(conn, kind, { database, file, password }, platform = process.platform) {
  const q = (s) => shellArg(s, platform);
  const { host, port } = where(conn, kind);
  const user = conn.user ? [kind === 'postgres' ? '-U' : '--user', q(conn.user)] : [];
  const parts =
    kind === 'postgres'
      ? ['pg_dump', '-h', q(host), '-p', port, ...user, '-Fc', '--no-password', '-f', q(file), q(database)]
      : ['mysqldump', '--host', q(host), '--port', port, ...user, '--single-transaction', '--routines', '--triggers', '--events', `--result-file=${q(file)}`, q(database)];
  return { command: parts.join(' '), env: toolEnv(conn, kind, password) };
}

/** The restore into `database` (made first when it isn't there): { command, env }. Over one that's there, Postgres drops what the dump has first. */
export function loadCommand(conn, kind, { database, file, password, replace }, platform = process.platform) {
  const q = (s) => shellArg(s, platform);
  const { host, port } = where(conn, kind);
  const user = conn.user ? [kind === 'postgres' ? '-U' : '--user', q(conn.user)] : [];
  const parts =
    kind === 'postgres'
      ? ['pg_restore', '-h', q(host), '-p', port, ...user, '--no-password', '--no-owner', '--no-privileges', ...(replace ? ['--clean', '--if-exists'] : []), '-d', q(database), q(file)]
      : ['mysql', '--host', q(host), '--port', port, ...user, q(database), '<', q(file)];
  return { command: parts.join(' '), env: toolEnv(conn, kind, password) };
}

/** Whether a tool's failure says it isn't installed (the shell couldn't find it). */
export const notInstalled = (e) => e?.code === 127 || e?.code === 9009 || /command not found|: not found|is not recognized as an internal or external command/i.test(`${e?.stderr ?? ''} ${e?.message ?? ''}`);

/** Whether the server is this machine, so a path on it is a path here too. */
export function onThisMachine(conn, machine, hostname) {
  const host = serverHost(conn.server ?? '').replace(/\\.*$/, '').toLowerCase();
  if (['localhost', '127.0.0.1', '::1', '.', '(local)'].includes(host) || host.startsWith('(localdb)')) return true;
  const me = String(hostname ?? '').toLowerCase();
  return Boolean(me) && (host === me || host.split('.')[0] === me || String(machine ?? '').toLowerCase() === me);
}

/**
 * /backup's and /restore's arguments (and /export-bacpac's and /import-bacpac's, by `command`):
 * { file, as } or { reason }, and for /export-bacpac `noData`: the tables to leave the data of out,
 * as given (names or patterns, from one or more --no-data, each a comma-separated list).
 */
export function parseBackupArgs(words, { restore = false, command = restore ? 'restore' : 'backup' } = {}) {
  const exporting = command === 'export-bacpac';
  const out = { file: null, as: null, ...(exporting ? { noData: [] } : {}) };
  const usage = restore ? `/${command} <file> [--as <database>]` : exporting ? `/${command} [file] [--no-data <table>,…]` : `/${command} [file]`;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (restore && w === '--as') {
      out.as = words[++i] ?? null;
      if (!out.as) return { reason: '--as names the database to restore into.' };
    } else if (exporting && w === '--no-data') {
      const list = (words[++i] ?? '').split(',').map((t) => t.trim()).filter(Boolean);
      if (!list.length) return { reason: '--no-data names the tables whose data to leave out: dbo.AuditLog, or a pattern such as log.* or *History, several split by commas.' };
      out.noData.push(...list);
    } else if (w.startsWith('--')) return { reason: `${usage} doesn't take ${w}.` };
    else if (out.file) return { reason: `One file: ${out.file}, then ${w}? Put a path with spaces in quotes.` };
    else out.file = w;
  }
  if (restore && !out.file) return { reason: `Which ${command === 'import-bacpac' ? '.bacpac' : 'backup'}? ${usage}` };
  return out;
}

// ---------------------------------------------------------------------------------------------------
// .bacpac (/export-bacpac and /import-bacpac): schema and data in one file, through SqlPackage on this machine. It
// works on Azure SQL Database too, which has no BACKUP to a file.

/** Why /export-bacpac or /import-bacpac won't run on `conn`, or null. An export only reads, so production is fine; an import makes a database. */
export function bacpacRefusal(conn, kind, { importing = false } = {}) {
  if (kind !== 'sqlserver') return `.bacpac is SQL Server's: ${kind === 'postgres' ? '/backup (pg_dump)' : '/backup (mysqldump)'} is ${kind === 'postgres' ? "PostgreSQL's" : "MySQL's"} copy to a file.`;
  if (conn.ssh) return `${conn.name} goes through an SSH tunnel, which SqlPackage can't use: run it on ${conn.ssh} instead.`;
  if (importing && conn.prod) return `${conn.name} is production: /import-bacpac only works on a connection that is neither production nor read-only, such as a dev server.`;
  if (importing && isReadOnly(conn)) return `${conn.name} is read-only: /import-bacpac only works on a connection that is neither production nor read-only, such as a dev server.`;
  return null;
}

/** Whether table `name` ("dbo.AuditLog") is meant by `pattern`: schema.table or a table in any schema, `*` for any run of characters, case aside. */
export function tableMatches(pattern, name) {
  const p = String(pattern).replace(/[[\]"]/g, '');
  const re = (s) => new RegExp(`^${s.split('*').map((x) => x.replace(/[.+?^${}()|\\]/g, '\\$&')).join('.*')}$`, 'i');
  if (p.includes('.')) return re(p).test(name);
  return re(p).test(name.slice(name.indexOf('.') + 1));
}

/**
 * For /export-bacpac --no-data: SqlPackage can only be told which tables' data to export (TableData),
 * so the tables `noData` doesn't mean are listed instead. `tables` are "schema.table" names, and
 * `foreignKeys` schema.js's: a kept table whose rows point into a left-out one is said in `orphans`
 * ({ from, to }), since its rows would point at nothing and the import would refuse its key.
 * Returns { keep, skipped, unmatched, orphans }.
 */
export function tableDataFor(tables, noData, foreignKeys = []) {
  const skipped = tables.filter((t) => noData.some((p) => tableMatches(p, t)));
  const left = new Set(skipped.map((t) => t.toLowerCase()));
  const keep = tables.filter((t) => !left.has(t.toLowerCase()));
  const unmatched = noData.filter((p) => !tables.some((t) => tableMatches(p, t)));
  const seen = new Set();
  const orphans = [];
  for (const f of foreignKeys) {
    const key = `${f.from}>${f.to}`.toLowerCase();
    if (left.has(f.to.toLowerCase()) && !left.has(f.from.toLowerCase()) && f.from.toLowerCase() !== f.to.toLowerCase() && !seen.has(key)) {
      seen.add(key);
      orphans.push({ from: f.from, to: f.to });
    }
  }
  return { keep, skipped, unmatched, orphans };
}

/** A table name as SqlPackage's TableData takes it: [schema].[table], so a dot or a space in a name can't split it. */
const tableDataName = (name) => {
  const i = name.indexOf('.');
  return [name.slice(0, i), name.slice(i + 1)].map((x) => `[${x.replace(/]/g, ']]')}]`).join('.');
};

export const SQLPACKAGE_FROM = 'SqlPackage (https://aka.ms/sqlpackage, or `dotnet tool install -g microsoft.sqlpackage`)';

/**
 * SqlPackage's command line: { command, env }. `side` is Source for an export, Target for an import.
 * An Entra login (azure-cli) goes through the connection string's "Active Directory Default", which
 * uses the az sign-in: no secret at all. SqlPackage has no environment variable or stdin for a SQL
 * login's password, so that one is on the command line (visible to this machine's other users).
 */
export function sqlpackageCommand(conn, { importing = false, database, file, password, tableData = null }, platform = process.platform) {
  const q = (s) => shellArg(s, platform);
  const side = importing ? 'Target' : 'Source';
  const trust = conn.trustCert ? ['True'] : [];
  const encrypt = String(conn.encrypt ?? true) === 'false' ? 'False' : 'True';
  const where =
    conn.auth === 'azure-cli'
      ? [`/${side}ConnectionString:${q(`Data Source=${conn.server};Initial Catalog=${database};Authentication=Active Directory Default;Encrypt=${encrypt}${trust.length ? ';TrustServerCertificate=True' : ''}`)}`]
      : [
          `/${side}ServerName:${q(conn.server)}`,
          `/${side}DatabaseName:${q(database)}`,
          ...(conn.user ? [`/${side}User:${q(conn.auth === 'ntlm' && conn.domain ? `${conn.domain}\\${conn.user}` : conn.user)}`] : []),
          ...(conn.user && password != null ? [`/${side}Password:${q(password)}`] : []),
          `/${side}EncryptConnection:${encrypt}`,
          ...(trust.length ? [`/${side}TrustServerCertificate:True`] : []),
        ];
  // SqlPackage gives each query 60 seconds by default, and a timeout breaks its connection: an export reading a
  // big table (or an import building its index) on a slow server then fails with the connection closed. esc cancels.
  const options = ['/p:CommandTimeout=0'];
  // An export spends most of its time on two things it can do without: zipping the table data at
  // Normal compression (Fast writes a somewhat bigger file in far less time), and checking the whole
  // schema model again once it has read it (minutes on a big schema; an import checks it anyway).
  if (!importing) options.push('/p:CompressionOption=Fast', '/p:VerifyExtraction=False');
  // Only these tables' data, when some is left out (every table's schema goes all the same).
  if (!importing && tableData) options.push(...tableData.map((t) => q(`/p:TableData=${tableDataName(t)}`)));
  const parts = importing ? ['sqlpackage', '/Action:Import', `/SourceFile:${q(file)}`, ...where, ...options] : ['sqlpackage', '/Action:Export', ...where, `/TargetFile:${q(file)}`, ...options];
  return { command: parts.join(' '), env: {} };
}

const DROPPED = /connection (was |is )?(closed|broken|terminated|reset)|closed before|transport-level error|forcibly closed|unable to reconnect|physical connection is not usable|timeout expired/i;

/**
 * What to say when a client tool (SqlPackage, pg_dump, …) fails: its own lines that say why, not only the
 * first. SqlPackage starts with "Connecting to …" and "Extracting schema" and puts the cause last, after
 * "*** Error …", so a failure keeps the lines from its first "***" on, else the last few. A connection
 * that dropped mid-run gets a line on what to do. `e` is run.js's RunError ({ message, stdout, stderr }).
 */
export function toolFailure(tool, e, { server } = {}) {
  const text = String(e?.stderr || '').trim() || String(e?.stdout || '').trim() || String(e?.message ?? '');
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim());
  const star = lines.findIndex((l) => /^\*\*\*/.test(l));
  const kept = (star >= 0 ? lines.slice(star) : lines).slice(-8);
  const out = [`${tool}: ${kept[0] ?? 'failed'}`, ...kept.slice(1)];
  if (DROPPED.test(text)) {
    out.push(`The connection${server ? ` to ${server}` : ''} dropped or timed out while ${tool} ran, and it doesn't pick up where it stopped: run it again. On Azure SQL Database a low tier, a scaling operation or failover can do it; the portal's Export runs it inside Azure instead.`);
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------------------
// Many tables on Windows: SqlPackage takes the tables whose data to export only as /p:TableData= on its
// command line, one per table, and Windows caps a command line (8191 characters through cmd.exe, 32767
// for any program). Past that, the export goes through SqlPackage's own library, DacFx, from PowerShell
// 7: DacServices.ExportBacpac takes the tables as a list, read here from a file, so there's no limit.

/** Whether SqlPackage's command line is too long for the shell run.js starts it through. */
export const tooLongForShell = (command, platform = process.platform) => platform === 'win32' && command.length > 8000;

export const POWERSHELL_FROM = 'PowerShell 7 (https://aka.ms/powershell), which the export of many tables goes through on Windows. Trawl looked on PATH, in Program Files\\PowerShell\\7, the Microsoft Store\'s and the dotnet tools\'';

/** A value for a SqlClient connection string: quoted when it has to be (a ; or a quote in a password). */
const csValue = (v) => {
  const s = String(v);
  return /[;'"=]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * The connection string DacFx signs in with, as SqlPackage would from its command line: Entra through
 * az (Active Directory Default), a SQL login with its password, else Windows' own sign-in.
 */
export function dacfxConnectionString(conn, { database, password }) {
  const parts = [['Data Source', conn.server], ['Initial Catalog', database]];
  if (conn.auth === 'azure-cli') parts.push(['Authentication', 'Active Directory Default']);
  else if (conn.user) {
    parts.push(['User ID', conn.auth === 'ntlm' && conn.domain ? `${conn.domain}\\${conn.user}` : conn.user]);
    if (password != null) parts.push(['Password', password]);
  } else parts.push(['Integrated Security', 'True']);
  parts.push(['Encrypt', String(conn.encrypt ?? true) === 'false' ? 'False' : 'True']);
  if (conn.trustCert) parts.push(['TrustServerCertificate', 'True']);
  return parts.map(([k, v]) => `${k}=${csValue(v)}`).join(';');
}

/** The tables to keep as the script reads them: schema, a tab, the table, one a line (a name may hold a dot). */
export const tableListText = (tables) =>
  tables
    .map((t) => {
      const i = t.indexOf('.');
      return `${t.slice(0, i)}\t${t.slice(i + 1)}`;
    })
    .join('\n');

/**
 * The PowerShell run: { command, env }. Everything it needs comes in the environment, the password
 * with the connection string, so none of it is on a command line; `script` and `list` are the files
 * DACFX_SCRIPT and tableListText were written to.
 */
/**
 * Where PowerShell 7 is: on PATH, else where its installers put it. PATH alone isn't enough: a program
 * keeps the PATH it started with, so a Trawl (or a Fleet window running it) opened before PowerShell
 * was installed wouldn't find it until restarted. `exists` is injected for the tests; "pwsh" when
 * none is found, for the shell to say it isn't there.
 */
export function findPwsh(env = process.env, exists = () => false, platform = process.platform) {
  if (platform !== 'win32') return 'pwsh';
  const get = (name) => env[name] ?? env[Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase())];
  const join = (...parts) => parts.join('\\').replace(/\\+/g, '\\');
  const candidates = [
    ...String(get('PATH') ?? '').split(';').filter(Boolean).map((dir) => join(dir.replace(/"/g, ''), 'pwsh.exe')),
    // The MSI and winget's install, for every user; a preview beside it.
    ...['ProgramFiles', 'ProgramW6432'].filter(get).flatMap((pf) => [join(get(pf), 'PowerShell', '7', 'pwsh.exe'), join(get(pf), 'PowerShell', '7-preview', 'pwsh.exe')]),
    // The Microsoft Store's, and `dotnet tool install --global PowerShell`.
    ...(get('LOCALAPPDATA') ? [join(get('LOCALAPPDATA'), 'Microsoft', 'WindowsApps', 'pwsh.exe')] : []),
    ...(get('USERPROFILE') ? [join(get('USERPROFILE'), '.dotnet', 'tools', 'pwsh.exe')] : []),
  ];
  return candidates.find((c) => exists(c)) ?? 'pwsh';
}

export function dacfxCommand(conn, { database, file, password, script, list, pwsh = 'pwsh' }, platform = process.platform) {
  const command = [pwsh === 'pwsh' ? 'pwsh' : shellArg(pwsh, platform), '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', shellArg(script, platform)].join(' ');
  return {
    command,
    env: { TRAWL_DAC_CONNECTION: dacfxConnectionString(conn, { database, password }), TRAWL_DAC_DATABASE: database, TRAWL_DAC_FILE: file, TRAWL_DAC_TABLES: list },
  };
}

// The script. It finds DacFx beside SqlPackage on PATH (or in the dotnet tools' store, where
// `dotnet tool install` puts it; TRAWL_DACFX names it otherwise), loads it with its own folder for the
// libraries it needs, and exports with the options SqlPackage's command line gets (no query time
// limit, Fast compression, no second check of the schema), each set only where this DacFx has it.
// Its progress comes through a small C# class, since DacFx raises its events on its own threads,
// where a PowerShell block can't run; without it the export still runs, quietly. A failure is said
// after "*** ", as SqlPackage says its own, which toolFailure keeps.
export const DACFX_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
try {
  $dac = $env:TRAWL_DACFX
  if (-not $dac) {
    $cmd = Get-Command sqlpackage -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $cmd) { throw "SqlPackage isn't on PATH, and its library (Microsoft.SqlServer.Dac.dll) is found beside it. Set TRAWL_DACFX to the library's path otherwise." }
    $dir = Split-Path -Parent $cmd.Source
    $dac = Join-Path $dir 'Microsoft.SqlServer.Dac.dll'
    if (-not (Test-Path -LiteralPath $dac)) {
      $store = Join-Path $dir '.store'
      $found = $null
      if (Test-Path -LiteralPath $store) {
        $found = Get-ChildItem -LiteralPath $store -Recurse -Filter 'Microsoft.SqlServer.Dac.dll' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
      }
      if (-not $found) { throw "Couldn't find Microsoft.SqlServer.Dac.dll beside SqlPackage ($dir). Set TRAWL_DACFX to its path." }
      $dac = $found.FullName
    }
  }
  $script:dacDir = Split-Path -Parent $dac
  $env:PATH = (Join-Path $script:dacDir 'runtimes\win-x64\native') + ';' + $script:dacDir + ';' + $env:PATH
  [System.AppContext]::SetSwitch('Switch.Microsoft.Data.SqlClient.UseManagedNetworkingOnWindows', $true)
  # A library with a build per system keeps the real one under runtimes\<rid>\lib\<framework>, and a
  # stand-in at the top of the folder that only says "not supported on this platform" (SqlClient
  # does). SqlPackage's own .deps.json picks the right one. Here the real ones are loaded before DacFx
  # is, so that when it asks for SqlClient it gets the one already loaded: waiting to be asked isn't
  # enough, as PowerShell's own resolver finds the stand-in beside DacFx first. What's left goes
  # through the handler below, in the same order: Windows x64's, Windows', then the top.
  $script:runtimeMajor = [Environment]::Version.Major
  function script:Best-Framework([string] $rid) {
    $lib = Join-Path $script:dacDir (Join-Path 'runtimes' (Join-Path $rid 'lib'))
    if (-not (Test-Path -LiteralPath $lib)) { return @() }
    return @(Get-ChildItem -LiteralPath $lib -Directory | ForEach-Object {
      $m = [regex]::Match($_.Name, '^net(\d+)\.\d+$')
      [pscustomobject]@{ Dir = $_.FullName; Major = $(if ($m.Success) { [int]$m.Groups[1].Value } else { 0 }) }
    } | Where-Object { $_.Major -le $script:runtimeMajor } | Sort-Object Major -Descending | ForEach-Object { $_.Dir })
  }
  function script:Find-Library([string] $name) {
    foreach ($rid in @('win-x64', 'win')) {
      foreach ($dir in (Best-Framework $rid)) {
        $path = Join-Path $dir ($name + '.dll')
        if (Test-Path -LiteralPath $path) { return $path }
      }
    }
    $path = Join-Path $script:dacDir ($name + '.dll')
    if (Test-Path -LiteralPath $path) { return $path }
    return $null
  }
  $loaded = @{}
  foreach ($a in [System.AppDomain]::CurrentDomain.GetAssemblies()) { $loaded[$a.GetName().Name] = $true }
  foreach ($rid in @('win-x64', 'win')) {
    $dir = Best-Framework $rid | Select-Object -First 1
    if (-not $dir) { continue }
    foreach ($dll in Get-ChildItem -LiteralPath $dir -Filter '*.dll') {
      if ($loaded[$dll.BaseName]) { continue }
      try {
        [void][System.Reflection.Assembly]::LoadFrom($dll.FullName)
        $loaded[$dll.BaseName] = $true
      } catch {
        [Console]::Out.WriteLine('Not loaded: ' + $dll.FullName + ' (' + $_.Exception.Message + ')')
      }
    }
  }
  [System.AppDomain]::CurrentDomain.add_AssemblyResolve([System.ResolveEventHandler] {
    param($source, $request)
    $path = Find-Library (New-Object System.Reflection.AssemblyName($request.Name)).Name
    if ($path) { return [System.Reflection.Assembly]::LoadFrom($path) }
    return $null
  })
  [void][System.Reflection.Assembly]::LoadFrom($dac)

  $tables = New-Object 'System.Collections.Generic.List[System.Tuple[string,string]]'
  foreach ($line in [System.IO.File]::ReadAllLines($env:TRAWL_DAC_TABLES, [System.Text.Encoding]::UTF8)) {
    if (-not $line) { continue }
    $tab = $line.IndexOf([char]9)
    $tables.Add([System.Tuple[string,string]]::new($line.Substring(0, $tab), $line.Substring($tab + 1)))
  }

  $script:sqlClient = { ([System.AppDomain]::CurrentDomain.GetAssemblies() | Where-Object { $_.GetName().Name -eq 'Microsoft.Data.SqlClient' } | ForEach-Object { $_.Location }) -join ', ' }
  [Console]::Out.WriteLine('DacFx from ' + $dac + '; SqlClient from ' + (& $script:sqlClient))
  $services = New-Object Microsoft.SqlServer.Dac.DacServices -ArgumentList $env:TRAWL_DAC_CONNECTION
  try {
    Add-Type -ReferencedAssemblies $dac -TypeDefinition @'
using System;
using Microsoft.SqlServer.Dac;
public static class TrawlDacProgress {
  public static void Follow(DacServices services) {
    services.Message += (s, e) => Console.Out.WriteLine(e.Message.ToString());
    services.ProgressChanged += (s, e) => { if (!string.IsNullOrEmpty(e.Message)) Console.Out.WriteLine(e.Message + " (" + e.Status + ")"); };
  }
}
'@
    [TrawlDacProgress]::Follow($services)
  } catch {
    [Console]::Out.WriteLine('DacFx gives no progress here: the export runs all the same.')
  }

  $options = New-Object Microsoft.SqlServer.Dac.DacExportOptions
  foreach ($want in @(@('CommandTimeout', 0), @('VerifyExtraction', $false), @('CompressionOption', 'Fast'))) {
    $property = $options.GetType().GetProperty($want[0])
    if (-not $property -or -not $property.CanWrite) { continue }
    try {
      $value = $want[1]
      if ($property.PropertyType.IsEnum) { $value = [Enum]::Parse($property.PropertyType, $value) }
      $property.SetValue($options, $value)
    } catch { }
  }

  [Console]::Out.WriteLine('Exporting ' + $env:TRAWL_DAC_DATABASE + ' through DacFx, the data of ' + $tables.Count + ' tables')
  $services.ExportBacpac($env:TRAWL_DAC_FILE, $env:TRAWL_DAC_DATABASE, $options, $tables, $null)
  [Console]::Out.WriteLine('Exported to ' + $env:TRAWL_DAC_FILE)
} catch {
  $top = $_.Exception
  $inner = $top
  while ($inner.InnerException) { $inner = $inner.InnerException }
  [Console]::Error.WriteLine('*** Error exporting database: ' + $top.Message)
  if ($inner -ne $top) { [Console]::Error.WriteLine($inner.Message) }
  if ($script:sqlClient) { [Console]::Error.WriteLine('SqlClient loaded from: ' + (& $script:sqlClient) + '; PowerShell ' + $PSVersionTable.PSVersion + ' on .NET ' + [Environment]::Version) }
  exit 1
}
`;
