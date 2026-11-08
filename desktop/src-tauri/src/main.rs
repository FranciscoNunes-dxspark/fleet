// Fleet's desktop window: one pseudo-terminal running the `fleet` host, drawn by xterm.js in the
// window's web view. The host and its apps are the same programs as in any terminal; what the window
// adds is its own frame, font and colours, and (later) the host's bar, palette and panels as real UI.
//
// The web view asks for four things: `start` (open the pty at its size and run Fleet), `write` (keys
// and pastes), `resize`, and `stop`. Fleet's output comes back as `pty-data` events (base64, since a
// read can end in the middle of a UTF-8 character and xterm.js puts the bytes back together), and its
// end as `pty-exit`.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::Mutex;
use std::thread;

use base64::{engine::general_purpose::STANDARD, Engine};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter, State};

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

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

#[tauri::command]
fn start(app: AppHandle, pty: State<Pty>, cols: u16, rows: u16) -> Result<(), String> {
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
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let killer = child.clone_killer();

    let out = app.clone();
    thread::spawn(move || {
        let mut buf = [0u8; 32 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let _ = out.emit("pty-data", STANDARD.encode(&buf[..n]));
                }
            }
        }
    });
    // Waited for apart from the reader: on Windows the pty's output may not end when Fleet does.
    let done = app.clone();
    thread::spawn(move || {
        let code = child.wait().map(|s| s.exit_code()).unwrap_or(1);
        let _ = done.emit("pty-exit", code);
    });

    *slot = Some(Session { master: pair.master, writer, killer });
    Ok(())
}

#[tauri::command]
fn write(pty: State<Pty>, data: String) -> Result<(), String> {
    let mut slot = pty.0.lock().map_err(|e| e.to_string())?;
    if let Some(session) = slot.as_mut() {
        session.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
        session.writer.flush().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn resize(pty: State<Pty>, cols: u16, rows: u16) -> Result<(), String> {
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
fn stop(pty: State<Pty>) -> Result<(), String> {
    // Dropping the session kills what's left of Fleet.
    pty.0.lock().map_err(|e| e.to_string())?.take();
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .manage(Pty::default())
        .invoke_handler(tauri::generate_handler![start, write, resize, stop])
        .run(tauri::generate_context!())
        .expect("Fleet's window couldn't start");
}
