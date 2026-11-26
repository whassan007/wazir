#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;

const MAX_PTY_SESSIONS: usize = 32;
const DIAGNOSTIC_NOTICE_VERSION: &str = "2026-11-20.1";

const USAGE: &str = concat!(
    "Usage: wazir-shell [--cwd <dir>] [--attach <path>]... [-c <input>]\n\n",
    "Options:\n",
    "  --cwd <dir>        Working directory for the initial tab\n",
    "  --attach <path>    Attach a file/directory (repeatable; passed as a structured list)\n",
    "  -c, --command <s>  Route <s> through the Wazir Shell router in a new tab (never /bin/sh -c)\n",
    "  -h, --help         Show this help and exit\n",
    "  -V, --version      Show version and exit\n",
);

/// Contract C1 launch arguments (reports/v0.4.3/INTEGRATION-CONTRACTS.md).
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
struct LaunchArgs {
    cwd: Option<String>,
    attachments: Vec<String>,
    command: Option<String>,
    #[serde(skip)]
    help: bool,
    #[serde(skip)]
    version: bool,
}

static LAUNCH_ARGS: OnceLock<LaunchArgs> = OnceLock::new();

/// Parses `wazir-shell [--cwd <dir>] [--attach <path>]... [-c <input>]`.
/// `args` excludes argv[0]. Values are taken verbatim as single argv elements;
/// nothing is ever joined or shell-interpreted.
fn parse_launch_args<I, S>(args: I) -> Result<LaunchArgs, String>
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    let mut out = LaunchArgs::default();
    let mut iter = args.into_iter().map(Into::into);
    let mut only_attachments = false;
    while let Some(arg) = iter.next() {
        if only_attachments {
            out.attachments.push(arg);
            continue;
        }
        let (flag, inline) = match arg.split_once('=') {
            Some((f, v)) if f.starts_with("--") => (f.to_string(), Some(v.to_string())),
            _ => (arg.clone(), None),
        };
        let mut take_value = |name: &str| -> Result<String, String> {
            match inline.clone() {
                Some(v) => Ok(v),
                None => iter.next().ok_or_else(|| format!("missing value for {name}")),
            }
        };
        match flag.as_str() {
            "--cwd" => out.cwd = Some(take_value("--cwd")?),
            "--attach" => out.attachments.push(take_value("--attach")?),
            "-c" | "--command" => out.command = Some(take_value("-c")?),
            "-h" | "--help" => out.help = true,
            "-V" | "--version" => out.version = true,
            "--" => only_attachments = true,
            other if other.starts_with('-') => return Err(format!("unknown option '{other}'")),
            other => return Err(format!("unexpected argument '{other}' (use --attach <path> or -c <input>)")),
        }
    }
    if let Some(cwd) = out.cwd.as_deref() {
        if cwd.trim().is_empty() {
            return Err("--cwd must not be empty".to_string());
        }
    }
    if out.attachments.iter().any(|a| a.is_empty()) {
        return Err("--attach path must not be empty".to_string());
    }
    Ok(out)
}

/// Resolves relative `--cwd` / `--attach` paths against the process cwd (and the
/// launch cwd for attachments) so the UI receives absolute paths.
fn resolve_launch_paths(mut args: LaunchArgs, process_cwd: &Path) -> Result<LaunchArgs, String> {
    let base = match args.cwd.as_deref() {
        Some(dir) => {
            let p = process_cwd.join(dir);
            if !p.is_dir() {
                return Err(format!("--cwd '{dir}' is not a directory"));
            }
            let canon = p.canonicalize().unwrap_or(p);
            args.cwd = Some(canon.to_string_lossy().to_string());
            canon
        }
        None => process_cwd.to_path_buf(),
    };
    args.attachments = args
        .attachments
        .iter()
        .map(|a| {
            let p = base.join(a);
            p.canonicalize().unwrap_or(p).to_string_lossy().to_string()
        })
        .collect();
    Ok(args)
}

fn launch_args() -> LaunchArgs {
    LAUNCH_ARGS.get().cloned().unwrap_or_default()
}

struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    pid: Option<u32>,
    shell: String,
    cwd: String,
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

#[derive(Serialize, Clone)]
struct PtyExitEvent {
    session_id: String,
    exit_code: Option<u32>,
}

#[derive(Serialize, Clone)]
struct AboutInfo {
    name: &'static str,
    version: &'static str,
    author: &'static str,
    repository: &'static str,
    website: &'static str,
    license: &'static str,
    third_party: &'static str,
}

fn is_executable_file(path: &str) -> bool {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return false;
    }
    let p = Path::new(trimmed);
    if !p.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(p) {
            return meta.permissions().mode() & 0o111 != 0;
        }
        false
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn discover_user_shell() -> String {
    if cfg!(target_os = "windows") {
        return std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string());
    }

    let settings_path = resolve_wazir_home_dir().join("shell-settings.json");
    if let Ok(raw) = std::fs::read_to_string(&settings_path) {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(pref) = val.get("preferredShell").and_then(|v| v.as_str()) {
                if is_executable_file(pref) {
                    return pref.to_string();
                }
            }
        }
    }

    if let Ok(env_shell) = std::env::var("SHELL") {
        if is_executable_file(&env_shell) {
            return env_shell;
        }
    }

    let user = std::env::var("USER")
        .or_else(|_| std::env::var("LOGNAME"))
        .unwrap_or_default();
    if !user.is_empty() {
        if let Ok(passwd) = std::fs::read_to_string("/etc/passwd") {
            for line in passwd.lines() {
                let mut parts = line.split(':');
                if parts.next() == Some(user.as_str()) {
                    if let Some(shell) = parts.nth(5) {
                        if is_executable_file(shell) {
                            return shell.to_string();
                        }
                    }
                }
            }
        }
        #[cfg(target_os = "macos")]
        {
            if let Ok(out) = std::process::Command::new("/usr/bin/dscl")
                .args([".", "-read", &format!("/Users/{user}"), "UserShell"])
                .output()
            {
                if out.status.success() {
                    let stdout = String::from_utf8_lossy(&out.stdout);
                    if let Some(shell) = stdout.split_whitespace().last() {
                        if is_executable_file(shell) {
                            return shell.to_string();
                        }
                    }
                }
            }
        }
    }

    for candidate in ["/bin/zsh", "/usr/bin/zsh", "/bin/bash", "/usr/bin/bash", "/bin/sh"] {
        if is_executable_file(candidate) {
            return candidate.to_string();
        }
    }
    "/bin/sh".to_string()
}

fn build_augmented_path() -> String {
    let existing = std::env::var("PATH").unwrap_or_default();
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    let mut parts: Vec<String> = existing
        .split(':')
        .filter(|s| !s.trim().is_empty())
        .map(String::from)
        .collect();
    let extras = [
        "/opt/homebrew/bin".to_string(),
        "/usr/local/bin".to_string(),
        format!("{home}/.cargo/bin"),
        format!("{home}/.local/bin"),
        "/usr/bin".to_string(),
        "/bin".to_string(),
        "/usr/sbin".to_string(),
        "/sbin".to_string(),
    ];
    for extra in extras {
        if !parts.iter().any(|p| p == &extra) {
            parts.push(extra);
        }
    }
    parts.join(":")
}

fn resolve_node_binary() -> String {
    if let Ok(explicit) = std::env::var("WAZIR_NODE_BIN") {
        let trimmed = explicit.trim();
        if !trimmed.is_empty() && Path::new(trimmed).exists() {
            return trimmed.to_string();
        }
    }
    for candidate in ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"] {
        if Path::new(candidate).exists() {
            return candidate.to_string();
        }
    }
    "node".to_string()
}

fn resolve_wa_binary() -> String {
    if let Ok(explicit) = std::env::var("WAZIR_CLI_BIN") {
        let trimmed = explicit.trim();
        if !trimmed.is_empty() && Path::new(trimmed).exists() {
            return trimmed.to_string();
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let adjacent_js = dir.join("wa.js");
            if adjacent_js.exists() {
                return adjacent_js.to_string_lossy().to_string();
            }
            let adjacent_bin = dir.join("wa");
            if adjacent_bin.exists() {
                return adjacent_bin.to_string_lossy().to_string();
            }
        }
    }
    for candidate in [
        "/usr/lib/wazir/wa.js",
        "/usr/bin/wa",
        "/usr/local/bin/wa",
        "/opt/homebrew/bin/wa",
    ] {
        if Path::new(candidate).exists() {
            return candidate.to_string();
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
    cmd.env("PATH", build_augmented_path());
    cmd.env("WAZIR_HOME", resolve_wazir_home_dir());
    if let Some(dir) = cwd {
        let trimmed = dir.trim();
        if !trimmed.is_empty() && Path::new(trimmed).is_dir() {
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

    let shell_path = discover_user_shell();
    let resolved_cwd = cwd
        .as_deref()
        .map(str::trim)
        .filter(|d| !d.is_empty() && Path::new(d).is_dir())
        .map(String::from)
        .or_else(|| std::env::var("HOME").ok())
        .unwrap_or_else(|| ".".to_string());

    let mut cmd = CommandBuilder::new(&shell_path);
    cmd.cwd(&resolved_cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("PATH", build_augmented_path());
    cmd.env("WAZIR_SHELL", "1");
    if std::env::var("LANG").unwrap_or_default().is_empty() {
        cmd.env("LANG", "en_US.UTF-8");
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn_command failed for {shell_path}: {e}"))?;
    let child_pid = child.process_id();

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone_reader failed: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take_writer failed: {e}"))?;

    {
        let sessions = state.sessions.lock().map_err(|_| "lock poisoned")?;
        if sessions.len() >= MAX_PTY_SESSIONS {
            return Err(format!("maximum PTY session limit ({MAX_PTY_SESSIONS}) reached"));
        }
    }

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
                child,
                pid: child_pid,
                shell: shell_path,
                cwd: resolved_cwd,
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
        let _ = app.emit(
            "pty-exit",
            PtyExitEvent {
                session_id: sid,
                exit_code: None,
            },
        );
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
    if let Some(mut session) = state
        .sessions
        .lock()
        .map_err(|_| "lock poisoned")?
        .remove(&session_id)
    {
        let _ = session.child.kill();
        let _ = session.child.wait();
    }
    Ok(())
}

fn detect_process_cwd(pid: u32) -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        if let Ok(link) = std::fs::read_link(format!("/proc/{pid}/cwd")) {
            return link.to_str().map(String::from);
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Ok(out) = std::process::Command::new("/usr/sbin/lsof")
            .args(["-a", "-p", &pid.to_string(), "-d", "cwd", "-Fn"])
            .output()
        {
            if out.status.success() {
                let stdout = String::from_utf8_lossy(&out.stdout);
                for line in stdout.lines() {
                    if let Some(rest) = line.strip_prefix('n') {
                        if !rest.is_empty() && Path::new(rest).is_dir() {
                            return Some(rest.to_string());
                        }
                    }
                }
            }
        }
    }
    let _ = pid;
    None
}

#[tauri::command]
fn pty_get_info(state: State<'_, ShellState>, session_id: String) -> Result<serde_json::Value, String> {
    let mut guard = state.sessions.lock().map_err(|_| "lock poisoned")?;
    let session = guard
        .get_mut(&session_id)
        .ok_or_else(|| format!("unknown session {session_id}"))?;
    if let Some(pid) = session.pid {
        if let Some(live_cwd) = detect_process_cwd(pid) {
            session.cwd = live_cwd;
        }
    }
    Ok(serde_json::json!({
        "session_id": session_id,
        "shell": session.shell,
        "cwd": session.cwd,
    }))
}

#[tauri::command]
async fn run_wazir_ai_task(
    prompt: String,
    cwd: Option<String>,
    model: Option<String>,
    permission_mode: Option<String>,
    attachments: Option<Vec<String>>,
) -> Result<String, String> {
    let trimmed = prompt.trim().to_string();
    if trimmed.is_empty() {
        return Err("AI prompt must not be empty".to_string());
    }
    let mut args = vec!["shell".to_string(), "-c".to_string(), trimmed];
    // Each attachment is its own argv element (contract C1); never interpolated into the prompt.
    for path in attachments.unwrap_or_default().into_iter().filter(|p| !p.is_empty()) {
        args.push("--attach".to_string());
        args.push(path);
    }
    if let Some(m) = model.as_deref().map(str::trim).filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case("auto")) {
        args.push("--model".to_string());
        args.push(m.to_string());
    }
    if let Some(perm) = permission_mode.as_deref().map(str::trim).filter(|s| matches!(*s, "ask" | "auto" | "read-only")) {
        args.push("--permissions".to_string());
        args.push(perm.to_string());
    }
    tauri::async_runtime::spawn_blocking(move || run_wa_subcommand(args, cwd))
        .await
        .map_err(|e| format!("AI task join failed: {e}"))?
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

const SUPPORTED_THEME_IDS: &[&str] = &[
    "tokyo-night",
    "catppuccin",
    "gruvbox",
    "rose-pine",
    "nord",
    "kanagawa",
    "everforest",
    "wazir-dark",
    "wazir-light",
];

fn resolve_wazir_home_dir() -> PathBuf {
    if let Ok(custom) = std::env::var("WAZIR_HOME") {
        let trimmed = custom.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home).join(".wazir");
    }
    std::env::temp_dir().join(".wazir")
}

#[tauri::command]
fn get_wazir_theme() -> Result<serde_json::Value, String> {
    let theme_path = resolve_wazir_home_dir().join("theme.json");
    if let Ok(raw) = std::fs::read_to_string(&theme_path) {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(id) = val.get("themeId").and_then(|v| v.as_str()) {
                if SUPPORTED_THEME_IDS.contains(&id) {
                    return Ok(serde_json::json!({ "themeId": id }));
                }
            }
        }
    }
    Ok(serde_json::json!({ "themeId": "tokyo-night" }))
}

#[tauri::command]
fn set_wazir_theme(theme_id: String) -> Result<serde_json::Value, String> {
    let normalized = theme_id.trim().to_lowercase();
    if !SUPPORTED_THEME_IDS.contains(&normalized.as_str()) {
        return Err(format!("Unsupported theme '{}'", theme_id));
    }
    let home = resolve_wazir_home_dir();
    std::fs::create_dir_all(&home).map_err(|e| format!("Failed to create Wazir home: {e}"))?;
    let theme_path = home.join("theme.json");
    let updated_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs().to_string())
        .unwrap_or_default();
    let payload = serde_json::json!({
        "themeId": normalized,
        "updatedAt": updated_at
    });
    let serialized = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
    std::fs::write(&theme_path, format!("{serialized}\n")).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "themeId": normalized }))
}

fn is_valid_custom_command_name(name: &str) -> bool {
    let trimmed = name.trim();
    !trimmed.is_empty()
        && trimmed.len() <= 64
        && !trimmed.contains("..")
        && trimmed
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
}

#[tauri::command]
fn list_wazir_custom_commands() -> Result<Vec<serde_json::Value>, String> {
    let dir = resolve_wazir_home_dir().join("commands");
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(out);
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        if let Ok(raw) = std::fs::read_to_string(&path) {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw) {
                if val.get("command").and_then(|v| v.as_str()).is_some() {
                    out.push(val);
                }
            }
        }
    }
    Ok(out)
}

#[tauri::command]
fn save_wazir_custom_command(
    name: String,
    description: String,
    command: String,
    mode: Option<String>,
) -> Result<serde_json::Value, String> {
    let trimmed_name = name.trim();
    if !is_valid_custom_command_name(trimmed_name) {
        return Err(format!("Invalid custom command name '{}'", name));
    }
    let trimmed_cmd = command.trim();
    if trimmed_cmd.is_empty() {
        return Err("Custom command cannot be empty".to_string());
    }
    let dir = resolve_wazir_home_dir().join("commands");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create commands dir: {e}"))?;
    let payload = serde_json::json!({
        "name": trimmed_name,
        "description": if description.trim().is_empty() { format!("Custom command: {trimmed_cmd}") } else { description.trim().to_string() },
        "command": trimmed_cmd,
        "mode": mode.unwrap_or_else(|| "shell".to_string()),
    });
    let file_path = dir.join(format!("{trimmed_name}.json"));
    let serialized = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
    std::fs::write(&file_path, format!("{serialized}\n")).map_err(|e| e.to_string())?;
    Ok(payload)
}

fn read_consent_json() -> serde_json::Value {
    let path = resolve_wazir_home_dir().join("consent.json");
    if let Ok(raw) = std::fs::read_to_string(&path) {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw) {
            return val;
        }
    }
    serde_json::json!({
        "noticeVersion": DIAGNOSTIC_NOTICE_VERSION,
        "accepted": false,
        "declined": false,
        "richAnalytics": false,
        "configuredLater": false,
        "onboardingCompleted": false,
        "installationId": null,
        "updatedAt": null
    })
}

fn write_restrictive_json(path: &Path, payload: &serde_json::Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create dir: {e}"))?;
    }
    let serialized = serde_json::to_string_pretty(payload).map_err(|e| e.to_string())?;
    std::fs::write(path, format!("{serialized}\n")).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

#[tauri::command]
fn set_consent_state(
    accepted: bool,
    declined: bool,
    rich_analytics: bool,
    configured_later: bool,
    onboarding_completed: bool,
) -> Result<serde_json::Value, String> {
    let home = resolve_wazir_home_dir();
    let existing = read_consent_json();
    let installation_id = existing
        .get("installationId")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(String::from)
        .unwrap_or_else(|| {
            let secs = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            format!("wazir-shell-{:x}", secs)
        });
    let updated_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs().to_string())
        .unwrap_or_default();

    let payload = serde_json::json!({
        "noticeVersion": DIAGNOSTIC_NOTICE_VERSION,
        "accepted": accepted && !declined,
        "declined": declined,
        "richAnalytics": accepted && !declined && rich_analytics,
        "configuredLater": configured_later,
        "onboardingCompleted": onboarding_completed,
        "installationId": installation_id,
        "updatedAt": updated_at
    });
    write_restrictive_json(&home.join("consent.json"), &payload)?;

    // Enforce zero diagnostic uploads/events when declined or not accepted
    if declined || !accepted {
        let queue_path = home.join("diagnostics-queue.jsonl");
        if queue_path.exists() {
            let _ = std::fs::remove_file(&queue_path);
        }
    }
    Ok(payload)
}

#[tauri::command]
fn save_shell_settings(settings: serde_json::Value) -> Result<serde_json::Value, String> {
    let home = resolve_wazir_home_dir();
    if let Some(theme_id) = settings.get("themeId").and_then(|v| v.as_str()) {
        if SUPPORTED_THEME_IDS.contains(&theme_id) {
            let _ = set_wazir_theme(theme_id.to_string());
        }
    }
    let path = home.join("shell-settings.json");
    write_restrictive_json(&path, &settings)?;
    Ok(settings)
}

fn read_shell_settings() -> serde_json::Value {
    let path = resolve_wazir_home_dir().join("shell-settings.json");
    if let Ok(raw) = std::fs::read_to_string(&path) {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw) {
            return val;
        }
    }
    let theme = get_wazir_theme()
        .ok()
        .and_then(|v| v.get("themeId").and_then(|t| t.as_str()).map(String::from))
        .unwrap_or_else(|| "tokyo-night".to_string());
    serde_json::json!({
        "themeId": theme,
        "fontSize": 13,
        "defaultMode": "auto",
        "permissionMode": "auto",
        "pinnedModel": "auto",
        "remoteHostId": null
    })
}

fn count_diagnostic_queue() -> usize {
    let queue_path = resolve_wazir_home_dir().join("diagnostics-queue.jsonl");
    std::fs::read_to_string(queue_path)
        .map(|s| s.lines().filter(|l| !l.trim().is_empty()).count())
        .unwrap_or(0)
}

#[tauri::command]
fn get_about_info() -> AboutInfo {
    AboutInfo {
        name: "Wazir Shell",
        version: env!("CARGO_PKG_VERSION"),
        author: "Wael Hassan (whassan007)",
        repository: "https://github.com/whassan007/wazir",
        website: "https://wazir.wael.bot",
        license: "GNU Affero General Public License v3.0 (AGPL-3.0-only)",
        third_party: "Includes selective Apache-2.0 components adapted from QwenLM/qwen-code",
    }
}

#[tauri::command]
fn get_shell_bootstrap() -> Result<serde_json::Value, String> {
    let launch = launch_args();
    let cwd = launch
        .cwd
        .clone()
        .or_else(|| std::env::current_dir().ok().and_then(|p| p.to_str().map(String::from)))
        .or_else(|| std::env::var("HOME").ok())
        .unwrap_or_else(|| ".".to_string());
    let custom_commands = list_wazir_custom_commands().unwrap_or_default();
    let verify_dir = std::env::var("WAZIR_SHELL_VERIFY_DIR").ok();
    Ok(serde_json::json!({
        "about": get_about_info(),
        "discovered_shell": discover_user_shell(),
        "initial_cwd": cwd,
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "consent": read_consent_json(),
        "diagnostic_queue_count": count_diagnostic_queue(),
        "settings": read_shell_settings(),
        "custom_commands": custom_commands,
        "verify_mode": verify_dir.is_some(),
        "launch": launch,
    }))
}

#[tauri::command]
async fn get_wazir_models_fast(refresh: Option<bool>) -> Result<serde_json::Value, String> {
    if refresh == Some(true) {
        let out = tauri::async_runtime::spawn_blocking(|| {
            run_wa_subcommand(vec!["models".into(), "--json".into()], None)
        })
        .await
        .map_err(|e| format!("models refresh join failed: {e}"))?;
        if let Ok(raw) = out {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw) {
                return Ok(val);
            }
        }
    }
    let cache_path = resolve_wazir_home_dir().join("fast-model-cache.json");
    if let Ok(raw) = std::fs::read_to_string(&cache_path) {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw) {
            return Ok(val);
        }
    }
    Ok(serde_json::json!({ "entries": [] }))
}

#[tauri::command]
fn get_wazir_fleet_fast() -> Result<serde_json::Value, String> {
    let hosts_path = resolve_wazir_home_dir().join("hosts.json");
    if let Ok(raw) = std::fs::read_to_string(&hosts_path) {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw) {
            return Ok(val);
        }
    }
    Ok(serde_json::json!({ "activeHostId": "local", "hosts": [] }))
}

#[tauri::command]
fn get_wazir_audit_logs(limit: Option<usize>) -> Result<Vec<serde_json::Value>, String> {
    let audit_path = resolve_wazir_home_dir().join("audit.jsonl");
    let max_items = limit.unwrap_or(25).min(100);
    let Ok(raw) = std::fs::read_to_string(&audit_path) else {
        return Ok(Vec::new());
    };
    let mut items = Vec::new();
    for line in raw.lines().rev() {
        if line.trim().is_empty() {
            continue;
        }
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(line) {
            items.push(val);
            if items.len() >= max_items {
                break;
            }
        }
    }
    items.reverse();
    Ok(items)
}

#[tauri::command]
fn open_mission_control(app: tauri::AppHandle) -> Result<(), String> {
    app.opener()
        .open_url("http://127.0.0.1:4801/mission-control.html", None::<&str>)
        .map_err(|e| format!("failed to open Mission Control: {e}"))
}

#[tauri::command]
fn save_verification_artifact(rel_path: String, content: String, is_base64: bool) -> Result<String, String> {
    let base = std::env::var("WAZIR_SHELL_VERIFY_DIR")
        .map_err(|_| "verification mode not enabled".to_string())?;
    if rel_path.contains("..") || rel_path.starts_with('/') {
        return Err("invalid artifact path".to_string());
    }
    let full = PathBuf::from(base).join(&rel_path);
    if let Some(parent) = full.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if is_base64 {
        let decoded = decode_base64(&content)?;
        std::fs::write(&full, decoded).map_err(|e| e.to_string())?;
    } else {
        std::fs::write(&full, content).map_err(|e| e.to_string())?;
    }
    Ok(full.to_string_lossy().to_string())
}

fn decode_base64(input: &str) -> Result<Vec<u8>, String> {
    let clean: String = input.chars().filter(|c| !c.is_whitespace()).collect();
    let table = |c: u8| -> Option<u8> {
        match c {
            b'A'..=b'Z' => Some(c - b'A'),
            b'a'..=b'z' => Some(c - b'a' + 26),
            b'0'..=b'9' => Some(c - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    };
    let bytes = clean.as_bytes();
    if bytes.len() % 4 != 0 {
        return Err("invalid base64 length".to_string());
    }
    let mut out = Vec::with_capacity(bytes.len() * 3 / 4);
    for chunk in bytes.chunks(4) {
        let a = table(chunk[0]).ok_or("invalid base64 char")?;
        let b = table(chunk[1]).ok_or("invalid base64 char")?;
        out.push((a << 2) | (b >> 4));
        if chunk[2] != b'=' {
            let c = table(chunk[2]).ok_or("invalid base64 char")?;
            out.push((b << 4) | (c >> 2));
            if chunk[3] != b'=' {
                let d = table(chunk[3]).ok_or("invalid base64 char")?;
                out.push((c << 6) | d);
            }
        }
    }
    Ok(out)
}

#[tauri::command]
fn exit_application(app: tauri::AppHandle, code: i32) {
    app.exit(code);
}

fn main() {
    let parsed = match parse_launch_args(std::env::args().skip(1)) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("wazir-shell: {e}\n\n{USAGE}");
            std::process::exit(2);
        }
    };
    if parsed.help {
        print!("{USAGE}");
        return;
    }
    if parsed.version {
        println!("wazir-shell {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    let process_cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let resolved = match resolve_launch_paths(parsed, &process_cwd) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("wazir-shell: {e}");
            std::process::exit(2);
        }
    };
    let _ = LAUNCH_ARGS.set(resolved);

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(ShellState::default())
        .setup(|app| {
            let new_tab = MenuItem::with_id(app, "new_tab", "New Terminal Tab", true, Some("CmdOrCtrl+T"))?;
            let close_tab = MenuItem::with_id(app, "close_tab", "Close Tab", true, Some("CmdOrCtrl+W"))?;
            let split_v = MenuItem::with_id(app, "split_v", "Split Vertically", true, Some("CmdOrCtrl+D"))?;
            let split_h = MenuItem::with_id(app, "split_h", "Split Horizontally", true, Some("CmdOrCtrl+Shift+D"))?;
            let cmd_palette = MenuItem::with_id(app, "command_palette", "Command Palette", true, Some("CmdOrCtrl+K"))?;
            let settings = MenuItem::with_id(app, "settings", "Settings...", true, Some("CmdOrCtrl+,"))?;
            let fleet_dash = MenuItem::with_id(app, "fleet_dashboard", "Fleet & Workflows", true, Some("CmdOrCtrl+Shift+F"))?;
            let open_mc = MenuItem::with_id(app, "open_mc", "Open Mission Control", true, Some("CmdOrCtrl+M"))?;
            let about = MenuItem::with_id(app, "about_wazir", "About Wazir Shell & Licensing", true, None::<&str>)?;

            let shell_menu = Submenu::with_items(
                app,
                "Shell",
                true,
                &[
                    &new_tab,
                    &close_tab,
                    &PredefinedMenuItem::separator(app)?,
                    &split_v,
                    &split_h,
                    &PredefinedMenuItem::separator(app)?,
                    &settings,
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
            let view_menu = Submenu::with_items(
                app,
                "View",
                true,
                &[
                    &cmd_palette,
                    &fleet_dash,
                    &open_mc,
                ],
            )?;
            let menu = Menu::with_items(app, &[&shell_menu, &edit_menu, &view_menu])?;
            app.set_menu(menu)?;

            app.on_menu_event(|app, event| {
                match event.id().as_ref() {
                    "new_tab" | "close_tab" | "split_v" | "split_h" | "command_palette" | "settings" | "fleet_dashboard" => {
                        let _ = app.emit("wazir-menu", event.id().as_ref());
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
                let _ = win.set_focus();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty_spawn,
            pty_write,
            pty_resize,
            pty_close,
            pty_get_info,
            run_wazir_ai_task,
            run_wazir_workflow,
            list_wazir_jobs,
            control_wazir_job,
            inspect_wazir_job,
            get_about_info,
            get_shell_bootstrap,
            set_consent_state,
            save_shell_settings,
            get_wazir_models_fast,
            get_wazir_fleet_fast,
            get_wazir_audit_logs,
            open_mission_control,
            get_wazir_theme,
            set_wazir_theme,
            list_wazir_custom_commands,
            save_wazir_custom_command,
            save_verification_artifact,
            exit_application
        ])
        .run(tauri::generate_context!())
        .expect("error running Wazir Shell");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Tests that mutate process-global WAZIR_HOME must not run concurrently.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn discovers_user_shell_and_node_binary() {
        let shell = discover_user_shell();
        assert!(!shell.is_empty());
        assert!(!resolve_node_binary().is_empty());
    }

    #[test]
    fn returns_about_info_with_agpl_license() {
        let info = get_about_info();
        assert_eq!(info.name, "Wazir Shell");
        assert_eq!(info.version, env!("CARGO_PKG_VERSION"));
        assert!(info.license.contains("AGPL-3.0-only"));
        assert!(!info.license.to_lowercase().contains("noncommercial"));
    }

    #[test]
    fn persists_consent_and_purges_diagnostics_on_decline() {
        let _env_guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let temp_home = std::env::temp_dir().join(format!("wazir-shell-consent-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp_home);
        std::fs::create_dir_all(&temp_home).unwrap();
        std::env::set_var("WAZIR_HOME", &temp_home);

        let queue_path = temp_home.join("diagnostics-queue.jsonl");
        std::fs::write(&queue_path, "{\"event\":\"test\"}\n").unwrap();
        assert!(queue_path.exists());

        let declined = set_consent_state(false, true, false, false, true).expect("decline");
        assert_eq!(declined["accepted"], false);
        assert_eq!(declined["declined"], true);
        assert!(!queue_path.exists());

        let accepted = set_consent_state(true, false, true, false, true).expect("accept");
        assert_eq!(accepted["accepted"], true);
        assert_eq!(accepted["richAnalytics"], true);

        let _ = std::fs::remove_dir_all(&temp_home);
        std::env::remove_var("WAZIR_HOME");
    }

    #[test]
    fn persists_settings_theme_and_custom_commands_in_isolated_home() {
        let _env_guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let temp_home = std::env::temp_dir().join(format!("wazir-shell-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp_home);
        std::env::set_var("WAZIR_HOME", &temp_home);

        let set_res = set_wazir_theme("catppuccin".to_string()).expect("set theme");
        assert_eq!(set_res["themeId"], "catppuccin");
        let get_res = get_wazir_theme().expect("get theme");
        assert_eq!(get_res["themeId"], "catppuccin");
        assert!(set_wazir_theme("nonexistent-theme".to_string()).is_err());

        let saved_settings = save_shell_settings(serde_json::json!({
            "themeId": "nord",
            "fontSize": 14,
            "defaultMode": "auto"
        }))
        .expect("save settings");
        assert_eq!(saved_settings["fontSize"], 14);
        assert_eq!(get_wazir_theme().unwrap()["themeId"], "nord");

        let saved = save_wazir_custom_command(
            "hello".to_string(),
            "Say hello".to_string(),
            "echo hello".to_string(),
            Some("shell".to_string()),
        )
        .expect("save custom command");
        assert_eq!(saved["name"], "hello");
        let listed = list_wazir_custom_commands().expect("list custom commands");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0]["name"], "hello");

        let bootstrap = get_shell_bootstrap().expect("bootstrap");
        assert!(bootstrap["discovered_shell"].as_str().unwrap().len() > 0);
        assert_eq!(bootstrap["custom_commands"].as_array().unwrap().len(), 1);

        let _ = std::fs::remove_dir_all(&temp_home);
        std::env::remove_var("WAZIR_HOME");
    }

    #[test]
    fn parses_c1_launch_argv() {
        let a = parse_launch_args(["--cwd", "/tmp", "--attach", "a b.txt", "--attach=$(rm -rf ~).md", "-c", "summarize these; echo pwned"]).unwrap();
        assert_eq!(a.cwd.as_deref(), Some("/tmp"));
        assert_eq!(a.attachments, vec!["a b.txt".to_string(), "$(rm -rf ~).md".to_string()]);
        assert_eq!(a.command.as_deref(), Some("summarize these; echo pwned"));
        assert!(!a.help);

        let empty = parse_launch_args(Vec::<String>::new()).unwrap();
        assert_eq!(empty, LaunchArgs::default());

        let dashdash = parse_launch_args(["--command", "explain", "--", "-weird-name", "x"]).unwrap();
        assert_eq!(dashdash.command.as_deref(), Some("explain"));
        assert_eq!(dashdash.attachments, vec!["-weird-name".to_string(), "x".to_string()]);

        // Values are the NEXT argv element verbatim, even when they start with '-'
        // (GNOME search queries may start with '-').
        let dash = parse_launch_args(["-c", "-rf foo", "--attach", "--help", "--cwd", "-dir"]).unwrap();
        assert_eq!(dash.command.as_deref(), Some("-rf foo"));
        assert_eq!(dash.attachments, vec!["--help".to_string()]);
        assert_eq!(dash.cwd.as_deref(), Some("-dir"));
        assert!(!dash.help);

        assert!(parse_launch_args(["--help"]).unwrap().help);
        assert!(parse_launch_args(["--cwd"]).is_err());
        assert!(parse_launch_args(["-c"]).is_err());
        assert!(parse_launch_args(["--bogus"]).is_err());
        assert!(parse_launch_args(["stray"]).is_err());
        assert!(parse_launch_args(["--attach", ""]).is_err());
    }

    #[test]
    fn resolves_launch_paths_against_cwd() {
        let base = std::env::temp_dir().join(format!("wazir-shell-argv-test-{}", std::process::id()));
        std::fs::create_dir_all(base.join("sub")).unwrap();
        let canon = base.canonicalize().unwrap();
        let a = parse_launch_args(["--cwd", "sub", "--attach", "f.txt", "--attach", "/abs/x"]).unwrap();
        let r = resolve_launch_paths(a, &canon).unwrap();
        assert_eq!(r.cwd.as_deref(), Some(canon.join("sub").to_str().unwrap()));
        assert_eq!(r.attachments[0], canon.join("sub").join("f.txt").to_string_lossy());
        assert_eq!(r.attachments[1], "/abs/x");
        let bad = parse_launch_args(["--cwd", "does-not-exist"]).unwrap();
        assert!(resolve_launch_paths(bad, &canon).is_err());
        let _ = std::fs::remove_dir_all(&base);
    }
}
