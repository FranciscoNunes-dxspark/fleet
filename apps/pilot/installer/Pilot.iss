; Pilot's installer, for Windows: pilot.exe for you alone (no administrator), on your PATH so terminals
; and Claude Code find it, a Start menu shortcut that opens Pilot in its own window (Edge's app window:
; a start page of recent projects and a folder picker, as Visual Studio opens), and "Open in Pilot" on
; folders and .sln files in Explorer. Pilot keeps itself up to date from there (pilot update; the window
; checks once a day).
; installer\build.ps1 builds it after `npm run build`:
;   iscc /DVersion=<version> installer\Pilot.iss   (writes dist\pilot-windows-x64-setup.exe)

#ifndef Version
  #define Version "0.0.0"
#endif

[Setup]
AppId={{9C3E5B7A-4F2D-4B8E-9A61-7D2C5E8F1B34}
AppName=Pilot
; No AppVersion: Pilot updates itself, so the version in Installed apps would soon be wrong.
AppVerName=Pilot
AppPublisher=DXSpark
VersionInfoVersion={#Version}
DefaultDirName={localappdata}\Programs\Pilot
DisableDirPage=yes
DisableProgramGroupPage=yes
; For the user: Pilot replaces its own exe when it updates, and the PATH it joins is the user's.
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
SetupIconFile=..\assets\logo.ico
UninstallDisplayIcon={app}\pilot.ico
UninstallDisplayName=Pilot
WizardStyle=modern
ChangesEnvironment=yes
OutputDir=..\dist
OutputBaseFilename=pilot-windows-x64-setup

[Messages]
FinishedLabel=Pilot is installed. Open it from the Start menu and pick your project's folder (File, Open folder), or right-click a project folder or a .sln and choose Open in Pilot. Its menu Claude Code, Set up connects Claude Code to the project; in a new terminal, pilot works anywhere.

[Tasks]
Name: path; Description: "Add pilot to my PATH (for terminals and Claude Code)"
Name: openwith; Description: "Add ""Open in Pilot"" to folders and .sln files in Explorer"
Name: desktopicon; Description: "Create a desktop shortcut"; Flags: unchecked

[Registry]
; Explorer: on a folder, on the empty space inside one, and on a solution. Opens Pilot's window on that
; project ("%V\.": a drive's own path ends in \, which would escape the closing quote).
Root: HKCU; Subkey: "Software\Classes\Directory\shell\Pilot"; ValueType: string; ValueData: "Open in Pilot"; Flags: uninsdeletekey; Tasks: openwith
Root: HKCU; Subkey: "Software\Classes\Directory\shell\Pilot"; ValueType: string; ValueName: "Icon"; ValueData: "{app}\pilot.ico"; Tasks: openwith
Root: HKCU; Subkey: "Software\Classes\Directory\shell\Pilot\command"; ValueType: string; ValueData: """{app}\pilot.exe"" app --root ""%V\."""; Tasks: openwith
Root: HKCU; Subkey: "Software\Classes\Directory\Background\shell\Pilot"; ValueType: string; ValueData: "Open in Pilot"; Flags: uninsdeletekey; Tasks: openwith
Root: HKCU; Subkey: "Software\Classes\Directory\Background\shell\Pilot"; ValueType: string; ValueName: "Icon"; ValueData: "{app}\pilot.ico"; Tasks: openwith
Root: HKCU; Subkey: "Software\Classes\Directory\Background\shell\Pilot\command"; ValueType: string; ValueData: """{app}\pilot.exe"" app --root ""%V\."""; Tasks: openwith
Root: HKCU; Subkey: "Software\Classes\SystemFileAssociations\.sln\shell\Pilot"; ValueType: string; ValueData: "Open in Pilot"; Flags: uninsdeletekey; Tasks: openwith
Root: HKCU; Subkey: "Software\Classes\SystemFileAssociations\.sln\shell\Pilot"; ValueType: string; ValueName: "Icon"; ValueData: "{app}\pilot.ico"; Tasks: openwith
Root: HKCU; Subkey: "Software\Classes\SystemFileAssociations\.sln\shell\Pilot\command"; ValueType: string; ValueData: """{app}\pilot.exe"" app --root ""%1"""; Tasks: openwith

[Files]
Source: "..\dist\pilot-windows-x64.exe"; DestDir: "{app}"; DestName: "pilot.exe"; Flags: ignoreversion
Source: "..\assets\logo.ico"; DestDir: "{app}"; DestName: "pilot.ico"; Flags: ignoreversion

[Icons]
; Pilot's window, on its start page. pilot app starts its server apart and returns at once, so the
; console it starts in only shows (minimized) for a moment; closing the window stops Pilot.
Name: "{userprograms}\Pilot"; Filename: "{app}\pilot.exe"; Parameters: "app"; WorkingDir: "{app}"; IconFilename: "{app}\pilot.ico"; Flags: runminimized
Name: "{userdesktop}\Pilot"; Filename: "{app}\pilot.exe"; Parameters: "app"; WorkingDir: "{app}"; IconFilename: "{app}\pilot.ico"; Flags: runminimized; Tasks: desktopicon

[Run]
Filename: "{userprograms}\Pilot.lnk"; Description: "Open Pilot"; Flags: shellexec nowait postinstall skipifsilent

[UninstallDelete]
; Pilot's updates move the exe they replace aside.
Type: files; Name: "{app}\*.old.*"
Type: filesandordirs; Name: "{app}\.pilot-update-*"

[Code]
// The user's PATH, with the install folder added once (and taken out again on uninstall).
const
  EnvKey = 'Environment';

function PathHas(Path, Dir: String): Boolean;
begin
  Result := Pos(';' + Uppercase(Dir) + ';', ';' + Uppercase(Path) + ';') > 0;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Path, Dir: String;
begin
  if (CurStep = ssPostInstall) and WizardIsTaskSelected('path') then
  begin
    Dir := ExpandConstant('{app}');
    if not RegQueryStringValue(HKCU, EnvKey, 'Path', Path) then Path := '';
    if not PathHas(Path, Dir) then
    begin
      if (Path <> '') and (Copy(Path, Length(Path), 1) <> ';') then Path := Path + ';';
      RegWriteExpandStringValue(HKCU, EnvKey, 'Path', Path + Dir);
    end;
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Path, Dir: String;
  P: Integer;
begin
  if CurUninstallStep = usPostUninstall then
  begin
    Dir := ExpandConstant('{app}');
    if RegQueryStringValue(HKCU, EnvKey, 'Path', Path) then
    begin
      Path := ';' + Path + ';';
      P := Pos(';' + Uppercase(Dir) + ';', Uppercase(Path));
      if P > 0 then
      begin
        Delete(Path, P, Length(Dir) + 1);
        Path := Copy(Path, 2, Length(Path) - 2);
        RegWriteExpandStringValue(HKCU, EnvKey, 'Path', Path);
      end;
    end;
  end;
end;
