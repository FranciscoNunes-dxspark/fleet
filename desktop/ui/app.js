// The window's side of Fleet: xterm.js drawing what the pseudo-terminal (src-tauri/src/main.rs) sends,
// and sending back keys, pastes, mouse reports and the size.
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// The shell look's palette, so Fleet's apps draw on the ground they were designed for.
const theme = {
  background: '#0f1115',
  foreground: '#d6dbe3',
  cursor: '#e6c07b',
  cursorAccent: '#0f1115',
  selectionBackground: '#263040',
  black: '#1a1e24',
  red: '#ff5f5f',
  green: '#7ee2a1',
  yellow: '#ffd75f',
  blue: '#5fafff',
  magenta: '#b48cff',
  cyan: '#3fb8b0',
  white: '#d6dbe3',
  brightBlack: '#5c6573',
  brightRed: '#ff8f8f',
  brightGreen: '#a6f0c0',
  brightYellow: '#ffe58f',
  brightBlue: '#8fc8ff',
  brightMagenta: '#d0b8ff',
  brightCyan: '#7fe0d8',
  brightWhite: '#f2f4f7',
};

const term = new Terminal({
  fontFamily: '"JetBrains Mono", "Cascadia Mono", "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace',
  fontSize: 14,
  lineHeight: 1.15,
  theme,
  allowProposedApi: true,
  macOptionIsMeta: true,
  // Fleet and its apps draw full-screen on the alternate screen: nothing to scroll back to.
  scrollback: 0,
  cursorBlink: false,
});
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open(document.getElementById('terminal'));
fit.fit();

const ended = document.getElementById('ended');
const endedText = document.getElementById('ended-text');
const where = document.getElementById('where');

const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
listen('pty-data', (e) => term.write(bytes(e.payload)));
listen('pty-exit', (e) => finished(`Fleet ended${e.payload ? ` (exit ${e.payload})` : ''}.`));

term.onData((data) => invoke('write', { data }));
// Old-style mouse reports come as bytes above 127, which onData doesn't carry.
term.onBinary((data) => invoke('write', { data }));
term.onResize(({ cols, rows }) => invoke('resize', { cols, rows }));
// The title an app sets (OSC 0/2) goes in the strip at the top.
term.onTitleChange((title) => (where.textContent = title));

new ResizeObserver(() => fit.fit()).observe(document.getElementById('terminal'));

function finished(text) {
  endedText.textContent = text;
  ended.hidden = false;
  document.getElementById('again').focus();
}

async function begin() {
  ended.hidden = true;
  term.reset();
  where.textContent = 'Fleet';
  try {
    await invoke('start', { cols: term.cols, rows: term.rows });
    term.focus();
  } catch (err) {
    finished(String(err));
  }
}

document.getElementById('again').addEventListener('click', async () => {
  await invoke('stop');
  begin();
});

begin();
