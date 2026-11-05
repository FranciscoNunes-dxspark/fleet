// The start window's ground: the projects opened before (most recent first, as Visual Studio keeps
// them), what a folder is (its solution's name, whether it looks like an MVC project), the folders
// inside one (the UI's own folder browser, which works everywhere), and the system's own folder
// picker: Windows' (the Explorer-style dialog, through PowerShell), macOS's (osascript), and zenity's
// or kdialog's on Linux. When there's no picker, the UI browses folders itself.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, parse, resolve } from 'node:path';

const MAX_RECENT = 15;

/** Pilot's own folder for what it keeps between runs (the recent list), beside its cache. */
export function stateDir(env = process.env) {
  return env.PILOT_CACHE ?? (process.platform === 'win32' ? join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'pilot') : join(env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'pilot'));
}

/** The projects opened before, most recent first, each still there or marked missing. */
export function recentProjects(env = process.env) {
  let list = [];
  try {
    list = JSON.parse(readFileSync(join(stateDir(env), 'recent.json'), 'utf8'));
  } catch {
    // None yet.
  }
  return (Array.isArray(list) ? list : []).map((p) => ({ ...p, missing: !existsSync(p.path) }));
}

function saveRecent(list, env) {
  mkdirSync(stateDir(env), { recursive: true });
  writeFileSync(join(stateDir(env), 'recent.json'), `${JSON.stringify(list.slice(0, MAX_RECENT), null, 2)}\n`);
}

/** Puts a project at the top of the recent list (pinned ones stay first). */
export function rememberProject(path, env = process.env) {
  const info = describeFolder(path);
  const list = recentProjects(env).filter((p) => !samePath(p.path, path));
  const entry = { path, name: info.name, solution: info.solution, at: new Date().toISOString(), pinned: recentProjects(env).find((p) => samePath(p.path, path))?.pinned ?? false };
  const pinned = list.filter((p) => p.pinned);
  saveRecent([...(entry.pinned ? [entry] : []), ...pinned, ...(entry.pinned ? [] : [entry]), ...list.filter((p) => !p.pinned)].map(({ missing, ...p }) => p), env);
}

export function forgetProject(path, env = process.env) {
  saveRecent(recentProjects(env).filter((p) => !samePath(p.path, path)).map(({ missing, ...p }) => p), env);
}

export function pinProject(path, pinned, env = process.env) {
  const list = recentProjects(env).map(({ missing, ...p }) => (samePath(p.path, path) ? { ...p, pinned } : p));
  saveRecent([...list.filter((p) => p.pinned), ...list.filter((p) => !p.pinned)], env);
}

const samePath = (a, b) => (process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));

/** A folder as the start window shows it: its name (the solution's, when it has one) and whether it looks like a web project. */
export function describeFolder(path) {
  let entries = [];
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    return { name: basename(path) || path, solution: null, web: false };
  }
  const sln = entries.find((e) => e.isFile() && /\.slnx?$/i.test(e.name))?.name ?? null;
  const web = entries.some((e) => (e.isFile() && /\.csproj$/i.test(e.name)) || (e.isDirectory() && /^(Views|Areas|wwwroot|Controllers)$/i.test(e.name))) || !!sln;
  return { name: sln ? sln.replace(/\.slnx?$/i, '') : basename(path) || path, solution: sln, web };
}

/** A path the user gave (a folder, or a file in one, like a .sln), as the folder to open. Null when it isn't one. */
export function projectFolder(given) {
  if (!given) return null;
  const path = resolve(String(given).trim().replace(/^"|"$/g, ''));
  try {
    const st = statSync(path);
    return st.isDirectory() ? path : st.isFile() ? dirname(path) : null;
  } catch {
    return null;
  }
}

/**
 * The folders inside `path` for the UI's folder browser: { path, parent, folders: [{ name, path, web }] },
 * hidden folders and build output left out. No path: the home folder, and on Windows the drives.
 */
export function listFolders(path) {
  const at = path ? resolve(path) : homedir();
  let entries = [];
  try {
    entries = readdirSync(at, { withFileTypes: true });
  } catch (e) {
    return { path: at, error: e.code === 'EACCES' || e.code === 'EPERM' ? 'No access to this folder.' : 'Not a folder.', folders: [], parent: dirname(at) !== at ? dirname(at) : null };
  }
  const folders = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !/^(node_modules|bin|obj|\$Recycle\.Bin|System Volume Information)$/i.test(e.name))
    .map((e) => ({ name: e.name, path: join(at, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    .slice(0, 500)
    .map((f) => ({ ...f, web: describeFolder(f.path).web }));
  const drives = process.platform === 'win32' ? 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((l) => `${l}:\\`).filter((d) => existsSync(d)) : [];
  return { path: at, parent: parse(at).root === at ? null : dirname(at), folders, drives, here: describeFolder(at), home: homedir() };
}

// Windows' Explorer-style folder dialog (IFileOpenDialog with FOS_PICKFOLDERS), from PowerShell,
// in front of the window that has the focus: Pilot's, as the click came from it.
const WINDOWS_PICKER = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")] class FileOpenDialogCoClass {}
[ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IShellItem {
  void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
  void GetParent(out IShellItem ppsi);
  void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
}
[ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IFileDialog {
  [PreserveSig] int Show(IntPtr parent);
  void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
  void SetFileTypeIndex(uint iFileType);
  void GetFileTypeIndex(out uint piFileType);
  void Advise(IntPtr pfde, out uint pdwCookie);
  void Unadvise(uint dwCookie);
  void SetOptions(uint fos);
  void GetOptions(out uint pfos);
  void SetDefaultFolder(IShellItem psi);
  void SetFolder(IShellItem psi);
  void GetFolder(out IShellItem ppsi);
  void GetCurrentSelection(out IShellItem ppsi);
  void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
  void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
  void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
  void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
  void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
  void GetResult(out IShellItem ppsi);
}
public static class PilotPicker {
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName(string path, IntPtr pbc, ref Guid riid, out IShellItem item);
  public static string Pick(string title, string start) {
    var d = (IFileDialog)new FileOpenDialogCoClass();
    d.SetOptions(0x20 | 0x40 | 0x800); // pick folders, file system only, path must exist
    d.SetTitle(title);
    d.SetOkButtonLabel("Open");
    if (!String.IsNullOrEmpty(start)) {
      try { var g = typeof(IShellItem).GUID; IShellItem si; SHCreateItemFromParsingName(start, IntPtr.Zero, ref g, out si); d.SetFolder(si); } catch {}
    }
    if (d.Show(GetForegroundWindow()) != 0) return null;
    IShellItem r; d.GetResult(out r);
    string p; r.GetDisplayName(0x80058000, out p); // SIGDN_FILESYSPATH
    return p;
  }
}
'@
$p = [PilotPicker]::Pick($env:PILOT_PICK_TITLE, $env:PILOT_PICK_START)
if ($p) { [Console]::Out.Write($p) }
`;

/** Which picker this system has: 'windows', 'macos', 'zenity', 'kdialog', or null. */
export function pickerKind(platform = process.platform, exists = existsSync, env = process.env) {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'macos';
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return null;
  for (const dir of String(env.PATH ?? '').split(':')) {
    if (exists(join(dir, 'zenity'))) return 'zenity';
    if (exists(join(dir, 'kdialog'))) return 'kdialog';
  }
  return null;
}

/**
 * Shows the system's folder picker: resolves with the folder chosen, null when cancelled, or
 * { unsupported: true } when there's none (the UI browses folders itself then).
 */
export function pickFolder({ title = 'Open a project folder', start = null, kind = pickerKind(), run = execFile } = {}) {
  const cmd = {
    windows: ['powershell', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_PICKER]],
    macos: ['osascript', ['-e', `POSIX path of (choose folder with prompt ${JSON.stringify(title)}${start ? ` default location (POSIX file ${JSON.stringify(start)})` : ''})`]],
    zenity: ['zenity', ['--file-selection', '--directory', `--title=${title}`, ...(start ? [`--filename=${start.replace(/\/?$/, '/')}`] : [])]],
    kdialog: ['kdialog', ['--getexistingdirectory', start ?? homedir(), '--title', title]],
  }[kind];
  if (!cmd) return Promise.resolve({ unsupported: true });
  return new Promise((ok) => {
    run(cmd[0], cmd[1], { windowsHide: true, encoding: 'utf8', timeout: 10 * 60 * 1000, env: { ...process.env, PILOT_PICK_TITLE: title, PILOT_PICK_START: start ?? '' } }, (err, stdout) => {
      // Cancelling is an exit code of its own in zenity, kdialog and osascript, and no output in Windows'.
      const path = String(stdout ?? '').trim().replace(/\/$/, '') || null;
      if (err && !path) return ok(err.code === 'ENOENT' ? { unsupported: true } : null);
      ok(path && existsSync(path) ? path : null);
    });
  });
}
