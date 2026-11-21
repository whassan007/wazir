#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;

struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
}

#[derive(Default)]
struct ShellState {
    sessions: Arc<Mutex<HashMap<String, PtySession>>>,
    next_id: Arc<Mutex<u64>>,
}

#[derive(Serialize, Clone)]
struct PtyOutputEvent {
    session_id: String,
    data: String,
}

#[derive(Serialize)]
struct AboutInfo {
    name: &'static str,
    version: &'static str,
    author: &'static str,
    repository: &'static str,
    website: &'static str,
    license: &'static str,
}

fn default_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| {
        if cfg!(target_os = "windows") {
            "cmd.exe".to_string()
        } else {
            "/bin/zsh".to_string()
        }
    })
}

fn resolve_node_binary() -> String {
    if let Ok(explicit) = std::env::var("WAZIR_NODE_BIN") {
        let trimmed = explicit.trim();
        if !trimmed.is_empty() && std::path::Path::new(trimmed).exists() {
            return trimmed.to_string();
        }
    }
    for candidate in ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"] {
        if std::path::Path::new(candidate).exists() {
            return candidate.to_string();
        }
    }
    "node".to_string()
}

fn resolve_wa_binary() -> String {
    if let Ok(explicit) = std::env::var("WAZIR_CLI_BIN") {
        let trimmed = explicit.trim();
        if !trimmed.is_empty() && std::path::Path::new(trimmed).exists() {
            return trimmed.to_string();
        }
    }
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let bundled = manifest_dir.join("../../../bin/wa.js");
    if bundled.exists() {
        return bundled.to_string_lossy().to_string();
    }
    "wa".to_string()
}

fn build_wa_command(cwd: Option<&str>) -> std::process::Command {
    let wa_path = resolve_wa_binary();
    let mut cmd = if wa_path.ends_with(".js") {
        let mut c = std::process::Command::new(resolve_node_binary());
        c.arg(&wa_path);
        c
    } else {
        std::process::Command::new(&wa_path)
    };
    if let Some(dir) = cwd {
        let trimmed = dir.trim();
        if !trimmed.is_empty() && std::path::Path::new(trimmed).is_dir() {
            cmd.current_dir(trimmed);
        }
    }
    cmd
}

fn run_wa_subcommand(args: Vec<String>, cwd: Option<String>) -> Result<String, String> {
    let mut cmd = build_wa_command(cwd.as_deref());
    cmd.args(&args);
    let output = cmd
        .output()
        .map_err(|e| format!("failed to run wa {}: {e}", args.first().map(String::as_str).unwrap_or("")))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if output.status.success() {
        Ok(stdout)
    } else if stderr.trim().is_empty() {
        Err(stdout)
    } else if stdout.trim().is_empty() {
        Err(stderr)
    } else {
        Err(format!("{stderr}\n{stdout}"))
    }
}

#[tauri::command]
fn pty_spawn(
    app: tauri::AppHandle,
    state: State<'_, ShellState>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
) -> Result<String, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.max(12),
            cols: cols.max(40),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty failed: {e}"))?;

    let mut cmd = CommandBuilder::new(default_shell());
    if let Some(dir) = cwd {
        if !dir.trim().is_empty() {
            cmd.cwd(dir);
        }
    } else if let Ok(home) = std::env::var("HOME") {
        cmd.cwd(home);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("WAZIR_SHELL", "1");

    let _child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn_command failed: {e}"))?;

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone_reader failed: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take_writer failed: {e}"))?;

    let mut id_guard = state.next_id.lock().map_err(|_| "lock poisoned")?;
    *id_guard += 1;
    let session_id = format!("pty-{}", *id_guard);
    drop(id_guard);

    state
        .sessions
        .lock()
        .map_err(|_| "lock poisoned")?
        .insert(
            session_id.clone(),
            PtySession {
                master: pair.master,
                writer,
            },
        );

    let sid = session_id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app.emit(
                        "pty-output",
                        PtyOutputEvent {
                            session_id: sid.clone(),
                            data: chunk,
                        },
                    );
                }
                Err(_) => break,
            }
        }
    });

    Ok(session_id)
}

#[tauri::command]
fn pty_write(state: State<'_, ShellState>, session_id: String, data: String) -> Result<(), String> {
    let mut guard = state.sessions.lock().map_err(|_| "lock poisoned")?;
    let session = guard
        .get_mut(&session_id)
        .ok_or_else(|| format!("unknown session {session_id}"))?;
    session
        .writer
        .write_all(data.as_bytes())
        .and_then(|_| session.writer.flush())
        .map_err(|e| format!("pty write failed: {e}"))
}

#[tauri::command]
fn pty_resize(state: State<'_, ShellState>, session_id: String, cols: u16, rows: u16) -> Result<(), String> {
    let guard = state.sessions.lock().map_err(|_| "lock poisoned")?;
    let session = guard
        .get(&session_id)
        .ok_or_else(|| format!("unknown session {session_id}"))?;
    session
        .master
        .resize(PtySize {
            rows: rows.max(12),
            cols: cols.max(40),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("pty resize failed: {e}"))
}

#[tauri::command]
fn pty_close(state: State<'_, ShellState>, session_id: String) -> Result<(), String> {
    state
        .sessions
        .lock()
        .map_err(|_| "lock poisoned")?
        .remove(&session_id);
    Ok(())
}

#[tauri::command]
fn run_wazir_ai_task(prompt: String, cwd: Option<String>) -> Result<String, String> {
    run_wa_subcommand(vec!["exec".into(), "--json".into(), prompt], cwd)
}

#[tauri::command]
async fn run_wazir_workflow(
    mode: String,
    prompt: String,
    cwd: Option<String>,
    dry_run: Option<bool>,
    max_iterations: Option<u32>,
    max_concurrency: Option<u32>,
    override_mode: Option<String>,
) -> Result<String, String> {
    let trimmed_prompt = prompt.trim().to_string();
    if trimmed_prompt.is_empty() {
        return Err("workflow prompt must not be empty".to_string());
    }
    let normalized_mode = mode.trim().to_ascii_lowercase();
    let mut args: Vec<String> = match normalized_mode.as_str() {
        "loop" => vec!["loop".into(), trimmed_prompt, "--json".into()],
        "graph" => vec!["graph".into(), trimmed_prompt, "--json".into()],
        "goal" | "auto" | "single" | "hybrid" | "" => {
            let mut v = vec!["goal".into(), "run".into(), trimmed_prompt, "--json".into()];
            let effective_override = override_mode
                .as_deref()
                .map(str::trim)
                .filter(|m| !m.is_empty() && !m.eq_ignore_ascii_case("auto"))
                .map(str::to_string)
                .or_else(|| {
                    if normalized_mode == "single" || normalized_mode == "hybrid" {
                        Some(normalized_mode.clone())
                    } else {
                        None
                    }
                });
            if let Some(m) = effective_override {
                v.push("--mode".into());
                v.push(m);
            }
            v
        }
        other => return Err(format!("unsupported workflow mode '{other}'")),
    };

    if dry_run == Some(true) {
        args.push("--dry-run".into());
    }
    if let Some(max_iter) = max_iterations {
        args.push("--max-iterations".into());
        args.push(max_iter.to_string());
    }
    if let Some(max_conc) = max_concurrency {
        args.push("--concurrency".into());
        args.push(max_conc.to_string());
    }

    tauri::async_runtime::spawn_blocking(move || run_wa_subcommand(args, cwd))
        .await
        .map_err(|e| format!("workflow task join failed: {e}"))?
}

#[tauri::command]
async fn list_wazir_jobs(
    status: Option<String>,
    mode: Option<String>,
    cwd: Option<String>,
) -> Result<String, String> {
    let mut args: Vec<String> = vec!["jobs".into(), "--json".into()];
    if let Some(st) = status.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        args.push("--status".into());
        args.push(st.to_string());
    }
    if let Some(md) = mode.as_deref().map(str::trim).filter(|m| !m.is_empty() && !m.eq_ignore_ascii_case("all")) {
        args.push("--mode".into());
        args.push(md.to_string());
    }
    tauri::async_runtime::spawn_blocking(move || run_wa_subcommand(args, cwd))
        .await
        .map_err(|e| format!("list_wazir_jobs join failed: {e}"))?
}

#[tauri::command]
async fn control_wazir_job(
    action: String,
    run_id: String,
    cwd: Option<String>,
) -> Result<String, String> {
    let act = action.trim().to_ascii_lowercase();
    if !matches!(act.as_str(), "pause" | "resume" | "stop") {
        return Err(format!("unsupported job control action '{action}'; expected pause, resume, or stop"));
    }
    let id = run_id.trim().to_string();
    if id.is_empty() {
        return Err("runId must not be empty".to_string());
    }
    let args = vec![act, id, "--json".into()];
    tauri::async_runtime::spawn_blocking(move || run_wa_subcommand(args, cwd))
        .await
        .map_err(|e| format!("control_wazir_job join failed: {e}"))?
}

#[tauri::command]
async fn inspect_wazir_job(run_id: String, cwd: Option<String>) -> Result<String, String> {
    let id = run_id.trim().to_string();
    if id.is_empty() {
        return Err("runId must not be empty".to_string());
    }
    let args = vec!["inspect".into(), id, "--json".into()];
    tauri::async_runtime::spawn_blocking(move || run_wa_subcommand(args, cwd))
        .await
        .map_err(|e| format!("inspect_wazir_job join failed: {e}"))?
}

#[tauri::command]
fn get_about_info() -> AboutInfo {
    AboutInfo {
        name: "Wazir Shell",
        version: env!("CARGO_PKG_VERSION"),
        author: "Wael Hassan (whassan007)",
        repository: "https://github.com/whassan007/wazir",
        website: "https://wazir.wael.bot",
        license: "AGPL-3.0-only (existing core/CLI) · Source-Available Noncommercial + Commercial Authorization",
    }
}

#[tauri::command]
fn open_mission_control(app: tauri::AppHandle) -> Result<(), String> {
    app.opener()
        .open_url("http://127.0.0.1:4801/mission-control.html", None::<&str>)
        .map_err(|e| format!("failed to open Mission Control: {e}"))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(ShellState::default())
        .setup(|app| {
            let new_tab = MenuItem::with_id(app, "new_tab", "New Terminal Tab", true, Some("CmdOrCtrl+T"))?;
            let open_mc = MenuItem::with_id(app, "open_mc", "Open Mission Control", true, Some("CmdOrCtrl+M"))?;
            let about = MenuItem::with_id(app, "about_wazir", "About Wazir Shell & Licensing", true, None::<&str>)?;

            let shell_menu = Submenu::with_items(
                app,
                "Shell",
                true,
                &[
                    &new_tab,
                    &open_mc,
                    &PredefinedMenuItem::separator(app)?,
                    &about,
                    &PredefinedMenuItem::quit(app, None)?,
                ],
            )?;
            let edit_menu = Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?;
            let menu = Menu::with_items(app, &[&shell_menu, &edit_menu])?;
            app.set_menu(menu)?;

            app.on_menu_event(|app, event| {
                match event.id().as_ref() {
                    "new_tab" => {
                        let _ = app.emit("wazir-menu", "new_tab");
                    }
                    "open_mc" => {
                        let _ = app.opener().open_url("http://127.0.0.1:4801/mission-control.html", None::<&str>);
                    }
                    "about_wazir" => {
                        let _ = app.emit("wazir-menu", "about");
                    }
                    _ => {}
                }
            });

            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty_spawn,
            pty_write,
            pty_resize,
            pty_close,
            run_wazir_ai_task,
            run_wazir_workflow,
            list_wazir_jobs,
            control_wazir_job,
            inspect_wazir_job,
            get_about_info,
            open_mission_control
        ])
        .run(tauri::generate_context!())
        .expect("error running Wazir Shell");
}
