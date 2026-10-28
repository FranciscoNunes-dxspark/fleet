// Fleet Desktop's menu. Its shortcuts keep out of the apps' way: on Windows and Linux a plain ctrl+letter
// belongs to the app on screen (ctrl+r, ctrl+w and ctrl+n all mean something in one of them), so the
// menu takes ctrl+shift combinations and function keys there; on macOS it takes cmd, which a terminal
// never sends.
const mac = process.platform === 'darwin';
const key = (letter) => (mac ? `Cmd+${letter}` : `Ctrl+Shift+${letter}`);

/** The menu's template: `command(name, arg)` sends the page a command, `openFolder()` asks for a folder. */
export function menuTemplate({ appName = 'Fleet', command, openFolder, newWindow }) {
  const spaces = ['Splice', 'Trawl', 'Sonar', 'Bosun', 'Hail', 'Keel', 'Wharf', 'Locker'];
  return [
    ...(mac ? [{ label: appName, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open Folder…', accelerator: key('O'), click: openFolder },
        { label: 'New Window', accelerator: key('N'), click: newWindow },
        { type: 'separator' },
        mac ? { role: 'close' } : { role: 'quit', accelerator: 'Ctrl+Shift+Q' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Copy Selection', accelerator: key('C'), role: 'copy' },
        { label: 'Paste', accelerator: key('V'), role: 'paste' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Commands…', accelerator: key('P'), click: () => command('palette') },
        { label: 'Split', accelerator: mac ? 'Cmd+\\' : 'Ctrl+Shift+\\', click: () => command('split') },
        { label: 'Runbooks', accelerator: key('R'), click: () => command('runbooks') },
        { label: 'Follow a Request…', accelerator: key('F'), click: () => command('trace') },
        { type: 'separator' },
        { role: 'zoomIn', accelerator: mac ? 'Cmd+=' : 'Ctrl+Shift+=' },
        { role: 'zoomOut', accelerator: mac ? 'Cmd+-' : 'Ctrl+Shift+-' },
        { role: 'resetZoom', accelerator: mac ? 'Cmd+0' : 'Ctrl+Shift+0' },
        { type: 'separator' },
        { role: 'togglefullscreen', accelerator: mac ? 'Ctrl+Cmd+F' : 'F11' },
        { role: 'reload', accelerator: 'Shift+F5' },
        { role: 'toggleDevTools', accelerator: 'F12' },
      ],
    },
    {
      label: 'Apps',
      submenu: spaces.map((name, i) => ({ label: name, accelerator: mac ? `Cmd+${i + 1}` : undefined, click: () => command('switch', name.toLowerCase()) })),
    },
    { role: 'windowMenu' },
    { role: 'help', submenu: [{ label: 'Keys', accelerator: 'F1', click: () => command('help') }] },
  ];
}
