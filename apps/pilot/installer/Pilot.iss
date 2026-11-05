; Pilot's installer, for Windows: pilot.exe for you alone (no administrator), on your PATH so terminals
; and Claude Code find it, a Start menu shortcut that opens Pilot's UI on the project picked here, and
; "Open in Pilot" on folders in Explorer. It can also set up Claude Code in that project (the skill and
; the MCP server). Pilot keeps itself up to date from there (pilot update; the UI checks once a day).
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
FinishedLabel=Pilot is installed. Open its UI from the Start menu (it opens in your browser; close its window to stop it), or right-click a project folder and choose Open in Pilot. In a new terminal, pilot works anywhere: pilot init --mcp in a project connects Claude Code.

[Tasks]
Name: path; Description: "Add pilot to my PATH (for terminals and Claude Code)"
Name: openwith; Description: "Add ""Open in Pilot"" to folders in Explorer"
Name: claude; Description: "Set up Claude Code in the project picked next (the skill and the MCP server, in .claude\ and .mcp.json)"; Flags: unchecked
Name: desktopicon; Description: "Create a desktop shortcut"; Flags: unchecked

[Registry]
; Explorer: on a folder, and on the empty space inside one. Opens the UI with that folder as the project
; ("%V\.": a drive's own path ends in \, which would escape the closing quote).
Root: HKCU; Subkey: "Software\Classes\Directory\shell\Pilot"; ValueType: string; ValueData: "Open in Pilot"; Flags: uninsdeletekey; Tasks: openwith
Root: HKCU; Subkey: "Software\Classes\Directory\shell\Pilot"; ValueType: string; ValueName: "Icon"; ValueData: "{app}\pilot.ico"; Tasks: openwith
Root: HKCU; Subkey: "Software\Classes\Directory\shell\Pilot\command"; ValueType: string; ValueData: """{app}\pilot.exe"" ui --root ""%V\."""; Tasks: openwith
Root: HKCU; Subkey: "Software\Classes\Directory\Background\shell\Pilot"; ValueType: string; ValueData: "Open in Pilot"; Flags: uninsdeletekey; Tasks: openwith
Root: HKCU; Subkey: "Software\Classes\Directory\Background\shell\Pilot"; ValueType: string; ValueName: "Icon"; ValueData: "{app}\pilot.ico"; Tasks: openwith
Root: HKCU; Subkey: "Software\Classes\Directory\Background\shell\Pilot\command"; ValueType: string; ValueData: """{app}\pilot.exe"" ui --root ""%V\."""; Tasks: openwith

[Files]
Source: "..\dist\pilot-windows-x64.exe"; DestDir: "{app}"; DestName: "pilot.exe"; Flags: ignoreversion
Source: "..\assets\logo.ico"; DestDir: "{app}"; DestName: "pilot.ico"; Flags: ignoreversion

[Icons]
; The UI for the project picked here; its window shows where it runs, and closing it stops Pilot.
Name: "{userprograms}\Pilot"; Filename: "{app}\pilot.exe"; Parameters: "ui"; WorkingDir: "{code:ProjectFolder}"; IconFilename: "{app}\pilot.ico"; Flags: runminimized
Name: "{userdesktop}\Pilot"; Filename: "{app}\pilot.exe"; Parameters: "ui"; WorkingDir: "{code:ProjectFolder}"; IconFilename: "{app}\pilot.ico"; Flags: runminimized; Tasks: desktopicon

[Run]
Filename: "{app}\pilot.exe"; Parameters: "init --mcp --command pilot"; WorkingDir: "{code:ProjectFolder}"; Flags: runhidden waituntilterminated; StatusMsg: "Setting up Claude Code in the project…"; Tasks: claude
Filename: "{userprograms}\Pilot.lnk"; Description: "Open Pilot"; Flags: shellexec nowait postinstall skipifsilent

[UninstallDelete]
; Pilot's updates move the exe they replace aside.
Type: files; Name: "{app}\*.old.*"
Type: filesandordirs; Name: "{app}\.pilot-update-*"

[Code]
var
  FolderPage: TInputDirWizardPage;

procedure InitializeWizard();
begin
  FolderPage := CreateInputDirPage(wpSelectTasks, 'Your project', 'Which project should Pilot open?',
    'The Start menu shortcut opens Pilot on this folder: the solution''s, or a web project''s. (Any other folder opens with right-click, Open in Pilot.) Pick it, then click Next.',
    False, '');
  FolderPage.Add('');
  FolderPage.Values[0] := GetPreviousData('Folder', GetEnv('USERPROFILE'));
end;

procedure RegisterPreviousData(PreviousDataKey: Integer);
begin
  SetPreviousData(PreviousDataKey, 'Folder', FolderPage.Values[0]);
end;

function ProjectFolder(Param: String): String;
begin
  Result := FolderPage.Values[0];
end;

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
