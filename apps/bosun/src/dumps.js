// Crash dumps for processes with "dump": true, written to Bosun's folder for the project
// (~/.bosun/dumps/<project>) and named after the process, so the log can say where each one is and
// `w` can tell Claude. A .NET (Core) process writes its own when it crashes, told to by the
// DOTNET_DbgEnableMiniDump settings; an IIS site's worker and a Windows service's process aren't
// Bosun's children, so ProcDump is attached to them (Windows). Pure apart from `dumpsDir`'s home.
import { join } from 'node:path';
import { configDir } from './config.js';
import { projectHash } from './recorder.js';

/** Where the project in `dir` keeps its dumps. */
export const dumpsDir = (dir, home = configDir()) => join(home, 'dumps', projectHash(dir));

/** The settings that make a .NET runtime write a full dump of `name` into `folder` when it crashes (.NET Core 3 read COMPlus_). */
export function dumpEnv(folder, name) {
  const file = join(folder, `${name}.%e.%p.%t.dmp`);
  const env = { DbgEnableMiniDump: '1', DbgMiniDumpType: '4', DbgMiniDumpName: file };
  return Object.fromEntries(Object.entries(env).flatMap(([k, v]) => [[`DOTNET_${k}`, v], [`COMPlus_${k}`, v]]));
}

/** ProcDump's arguments: a full dump of `pid` into `folder` when an unhandled exception ends it, named after `name`. */
export const procdumpArgs = (pid, folder, name) => ['-accepteula', '-ma', '-e', String(pid), join(folder, `${name}_PROCESSNAME_PID_YYMMDD_HHMMSS.dmp`)];

/** Whether a file in the dumps folder is `name`'s (`name.` from the runtime, `name_` from ProcDump). */
export const isDumpOf = (file, name) => /\.dmp$/i.test(file) && (file.startsWith(`${name}.`) || file.startsWith(`${name}_`));

/** The ProcDump lines worth a place in the log. */
export const procdumpSays = (line) => /Dump \d+ (initiated|complete|writing)|Exception:|^\[[\d:.]+\] (Exception|Dump)|Error|Access is denied/i.test(line);

/** 123 456 789 bytes as "118 MB". */
export const dumpSize = (bytes) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`);

/** The log's line for a new dump. */
export const dumpNote = (path, bytes) => `── crash dump written: ${path}${bytes ? ` (${dumpSize(bytes)})` : ''}: open it with dotnet-dump analyze, WinDbg or Visual Studio`;

/** ProcDump's install line. */
export const PROCDUMP_HINT = 'winget install Microsoft.Sysinternals.ProcDump, or https://learn.microsoft.com/sysinternals/downloads/procdump';
