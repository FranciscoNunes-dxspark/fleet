; Fleet's installer, for Windows: Fleet, and the Windows Terminal it opens in, so it never runs in
; Windows' own console (one font, no fallback to another, so characters drawn as boxes, and ctrl+c
; and ctrl+v sent on as keys). The terminal is the portable release pinned in terminal.json, with
; Fleet's settings: a Fleet profile, a font list, copy and paste on ctrl+c and ctrl+v. The Start
; menu shortcut opens it in the folder picked here, and Fleet keeps itself up to date from there.
; installer\build.ps1 builds it after `npm run build`:
;   iscc /DVersion=<version> /DTerminal=<the unpacked terminal> installer\Fleet.iss   (writes dist\)

#ifndef Version
  #define Version "0.0.0"
#endif
#ifndef Terminal
  #error Pass /DTerminal=<the unpacked portable Windows Terminal>: installer\build.ps1 does.
#endif

[Setup]
AppId={{46D1E2C3-70FB-4A7E-BA78-B4A71FC7561F}
AppName=Fleet
; No AppVersion: Fleet updates itself, so the version in Installed apps would soon be wrong.
AppVerName=Fleet
VersionInfoVersion={#Version}
; Always here: the terminal's settings name fleet.exe by this path (through %LOCALAPPDATA%).
DefaultDirName={localappdata}\Programs\Fleet
DisableDirPage=yes
DisableProgramGroupPage=yes
; For the user: Fleet replaces its own exe when it updates.
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
SetupIconFile=..\assets\logo.ico
UninstallDisplayIcon={app}\fleet.ico
UninstallDisplayName=Fleet
WizardStyle=modern
OutputDir=..\dist
OutputBaseFilename=fleet-windows-x64-setup

[Messages]
FinishedLabel=Fleet is installed. Open it from the Start menu: Splice, Trawl, Sonar, Bosun, Hail and Keel in one window, switched with ctrl+].

[Tasks]
Name: desktopicon; Description: "Create a desktop shortcut"; Flags: unchecked

[Files]
Source: "..\dist\fleet-windows-x64.exe"; DestDir: "{app}"; DestName: "fleet.exe"; Flags: ignoreversion
Source: "..\assets\logo.ico"; DestDir: "{app}"; DestName: "fleet.ico"; Flags: ignoreversion
Source: "{#Terminal}\*"; DestDir: "{app}\terminal"; Flags: ignoreversion recursesubdirs createallsubdirs
; Yours once it's there (a font, a size): kept when Fleet is installed again.
Source: "settings.json"; DestDir: "{app}\terminal\settings"; Flags: onlyifdoesntexist

[Icons]
; With an AppUserModelID of Fleet's own, so the terminal's windows go under this shortcut's button,
; with its icon. The terminal starts in the shortcut's folder (the profile's startingDirectory is null).
Name: "{userprograms}\Fleet"; Filename: "{app}\terminal\WindowsTerminal.exe"; Parameters: "-p Fleet"; WorkingDir: "{code:ProjectsFolder}"; IconFilename: "{app}\fleet.ico"; AppUserModelID: "FranciscoNunes.Fleet"
Name: "{userdesktop}\Fleet"; Filename: "{app}\terminal\WindowsTerminal.exe"; Parameters: "-p Fleet"; WorkingDir: "{code:ProjectsFolder}"; IconFilename: "{app}\fleet.ico"; AppUserModelID: "FranciscoNunes.Fleet"; Tasks: desktopicon

[Run]
; Through the shortcut, for its AppUserModelID.
Filename: "{userprograms}\Fleet.lnk"; Description: "Open Fleet"; Flags: shellexec nowait postinstall skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{app}\terminal"
; Fleet's updates move the exe they replace aside.
Type: files; Name: "{app}\*.old.*"

[Code]
var
  FolderPage: TInputDirWizardPage;

procedure InitializeWizard();
var
  Default: String;
begin
  FolderPage := CreateInputDirPage(wpSelectTasks, 'Your work', 'Which folder should Fleet open in?',
    'The apps start in this folder: Splice and Bosun look for repositories and projects in it. Pick the folder that holds them, then click Next.',
    False, '');
  FolderPage.Add('');
  Default := GetEnv('USERPROFILE');
  if DirExists(ExpandConstant('{sd}\Team')) then Default := ExpandConstant('{sd}\Team');
  FolderPage.Values[0] := GetPreviousData('Folder', Default);
end;

procedure RegisterPreviousData(PreviousDataKey: Integer);
begin
  SetPreviousData(PreviousDataKey, 'Folder', FolderPage.Values[0]);
end;

function ProjectsFolder(Param: String): String;
begin
  Result := FolderPage.Values[0];
end;
