// The one thing Fleet Desktop gives the page beyond what a browser does: the menu's commands (open a
// folder, split, runbooks…), as calls the page listens for. Nothing of Node reaches the page.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fleetDesktop', {
  onCommand(fn) {
    ipcRenderer.on('fleet:command', (_event, command) => fn(command));
  },
});
