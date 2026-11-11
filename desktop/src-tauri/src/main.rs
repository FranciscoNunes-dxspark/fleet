// Fleet's desktop window: one pseudo-terminal running the `fleet` host, drawn by xterm.js in the
// window's web view. The host and its apps are the same programs as in any terminal; what the window
// adds is its own frame, font and colours, and (later) the host's bar, palette and panels as real UI.
//
// The web view asks for five things: `start` (open the pty at its size and run Fleet), `write` (keys
// and pastes), `resize`, `ack` (how much output xterm.js has drawn) and `stop`. Fleet's output comes
// back through the channel `start` was given, as raw bytes (an ArrayBuffer on the other side, with no
// base64 or JSON in between: a read can end in the middle of a UTF-8 character, and xterm.js puts the
// bytes back together), and its end as the `pty-exit` event.
//
// Nothing here runs on the window's own thread. The commands are async (Tauri runs a plain one on the
// main thread, where a write the pty isn't ready for would freeze the whole window), keys go to a
// writer thread of their own, and output is read on one thread and sent on another, so whatever piled
// up while a send was under way goes over as one message rather than hundreds of small ones.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, Sender, SyncSender, TryRecvError};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::Duration;

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, State};

struct Session {
    master: Box<dyn MasterPty + Send>,
    /// Keys and pastes for the writer thread: a write never waits on the pty.
    input: Sender<Vec<u8>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    flow: Arc<Flow>,
}

/// Output sent to the web view that xterm.js hasn't drawn yet. Past HIGH the sender waits until the
/// window catches up, so a flood (a build's log, a big diff) can't queue seconds of work behind the
/// next keystroke; the reader then fills its bounded queue and stops reading, and the pty holds Fleet
/// back as a terminal would.
#[derive(Default)]
struct Flow {
    unacked: Mutex<usize>,
    drawn: Condvar,
}

const HIGH: usize = 512 * 1024;
/// The most one message carries.
const BATCH: usize = 1024 * 1024;
/// How long the sender waits for acks before going on anyway: a window that stopped acking (reloaded,
/// or an error in the page) must not stall Fleet for good.
const ACK_WAIT: Duration = Duration::from_secs(2);

impl Drop for Session {
    fn drop(&mut self) {
        // The window closing (or a restart) ends Fleet, which ends its apps.
        let _ = self.killer.kill();
    }
}

#[derive(Default)]
struct Pty(Mutex<Option<Session>>);

/// What to run: FLEET_COMMAND when set (from a checkout, "node /path/to/fleet/apps/fleet/bin/fleet.js"),
/// else a `fleet` beside this executable (how an installer would lay them out), else `fleet` on the PATH.
fn fleet_command() -> CommandBuilder {
    if let Ok(line) = std::env::var("FLEET_COMMAND") {
        let mut parts = line.split_whitespace();
        if let Some(program) = parts.next() {
            let mut cmd = CommandBuilder::new(program);
            cmd.args(parts);
            return cmd;
        }
    }
    let beside = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join(if cfg!(windows) { "fleet.exe" } else { "fleet" })))
        .filter(|path| path.exists());
    CommandBuilder::new(beside.map(PathBuf::into_os_string).unwrap_or_else(|| "fleet".into()))
}

/// The folder Fleet starts in: FLEET_CWD, else the home folder.
fn start_folder() -> Option<String> {
    std::env::var("FLEET_CWD")
        .ok()
        .or_else(|| std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).ok())
}

/// Reads Fleet's output as it comes, a read at a time, for `send_output`.
fn read_output(mut reader: Box<dyn Read + Send>, chunks: SyncSender<Vec<u8>>) {
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        match reader.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if chunks.send(buf[..n].to_vec()).is_err() {
                    break;
                }
            }
        }
    }
}

/// Sends the output to the web view: a read on its own when nothing else is waiting (a keystroke's echo
/// goes at once), or everything that came in the meantime as one message.
fn send_output(received: Receiver<Vec<u8>>, output: Channel<InvokeResponseBody>, flow: Arc<Flow>) {
    while let Ok(mut batch) = received.recv() {
        let mut open = true;
        while batch.len() < BATCH {
            match received.try_recv() {
                Ok(more) => batch.extend_from_slice(&more),
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    open = false;
                    break;
                }
            }
        }
        let size = batch.len();
        if output.send(InvokeResponseBody::Raw(batch)).is_err() {
            break;
        }
        if let Ok(mut unacked) = flow.unacked.lock() {
            *unacked += size;
            while *unacked > HIGH {
                match flow.drawn.wait_timeout(unacked, ACK_WAIT) {
                    Ok((guard, wait)) => {
                        unacked = guard;
                        if wait.timed_out() {
                            *unacked = 0;
                        }
                    }
                    Err(_) => return,
                }
            }
        }
        if !open {
            break;
        }
    }
}

/// Writes keys and pastes to the pty, everything queued at once before a flush.
fn write_input(mut writer: Box<dyn Write + Send>, keys: Receiver<Vec<u8>>) {
    while let Ok(data) = keys.recv() {
        if writer.write_all(&data).is_err() {
            return;
        }
        while let Ok(more) = keys.try_recv() {
            if writer.write_all(&more).is_err() {
                return;
            }
        }
        if writer.flush().is_err() {
            return;
        }
    }
}

#[tauri::command]
async fn start(app: AppHandle, pty: State<'_, Pty>, cols: u16, rows: u16, output: Channel<InvokeResponseBody>) -> Result<(), String> {
    let mut slot = pty.0.lock().map_err(|e| e.to_string())?;
    if slot.is_some() {
        return Ok(());
    }
    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("No pseudo-terminal: {e}"))?;
    let mut cmd = fleet_command();
    // xterm.js understands what xterm does, in 24-bit colour.
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("FLEET_DESKTOP", "1");
    if let Some(dir) = start_folder() {
        cmd.cwd(dir);
    }
    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Couldn't start Fleet ({e}). Is `fleet` installed, or FLEET_COMMAND set?"))?;
    drop(pair.slave);
    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let killer = child.clone_killer();

    let (chunks, received) = mpsc::sync_channel::<Vec<u8>>(64);
    thread::spawn(move || read_output(reader, chunks));
    let flow = Arc::new(Flow::default());
    let sending = flow.clone();
    thread::spawn(move || send_output(received, output, sending));
    let (input, keys) = mpsc::channel::<Vec<u8>>();
    thread::spawn(move || write_input(writer, keys));
    // Waited for apart from the reader: on Windows the pty's output may not end when Fleet does.
    let done = app.clone();
    thread::spawn(move || {
        let code = child.wait().map(|s| s.exit_code()).unwrap_or(1);
        let _ = done.emit("pty-exit", code);
    });

    *slot = Some(Session { master: pair.master, input, killer, flow });
    Ok(())
}

#[tauri::command]
async fn write(pty: State<'_, Pty>, data: String) -> Result<(), String> {
    let slot = pty.0.lock().map_err(|e| e.to_string())?;
    if let Some(session) = slot.as_ref() {
        session.input.send(data.into_bytes()).map_err(|_| "Fleet isn't reading its input".to_string())?;
    }
    Ok(())
}

/// xterm.js has drawn this much more of the output.
#[tauri::command]
async fn ack(pty: State<'_, Pty>, bytes: usize) -> Result<(), String> {
    let slot = pty.0.lock().map_err(|e| e.to_string())?;
    if let Some(session) = slot.as_ref() {
        if let Ok(mut unacked) = session.flow.unacked.lock() {
            *unacked = unacked.saturating_sub(bytes);
        }
        session.flow.drawn.notify_all();
    }
    Ok(())
}

#[tauri::command]
async fn resize(pty: State<'_, Pty>, cols: u16, rows: u16) -> Result<(), String> {
    let slot = pty.0.lock().map_err(|e| e.to_string())?;
    if let Some(session) = slot.as_ref() {
        session
            .master
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn stop(pty: State<'_, Pty>) -> Result<(), String> {
    // Dropping the session kills what's left of Fleet (outside the lock: a kill can take a moment).
    let session = pty.0.lock().map_err(|e| e.to_string())?.take();
    drop(session);
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(Pty::default())
        .invoke_handler(tauri::generate_handler![start, write, resize, ack, stop])
        .run(tauri::generate_context!())
        .expect("Fleet's window couldn't start");
}
