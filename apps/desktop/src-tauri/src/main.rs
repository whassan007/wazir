#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashSet;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use rand::Rng;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Emitter, Manager, Wry};
use tauri_plugin_opener::OpenerExt;

const WEB_PORT: u16 = 4801;
const API_PORT: u16 = 4800;
const DASHBOARD_URL: &str = "http://127.0.0.1:4801";
const HEALTH_TIMEOUT: Duration = Duration::from_secs(20);
const HEALTH_POLL_INTERVAL: Duration = Duration::from_millis(200);
const KEYCHAIN_SERVICE: &str = "ai.wazir.desktop.operator";
const KEYCHAIN_ACCOUNT: &str = "local";

fn logs_dir() -> PathBuf {
    dirs_log_dir().join("Wazir")
}

fn wazir_home_dir() -> PathBuf {
    if let Ok(custom) = std::env::var("WAZIR_HOME") {
        let trimmed = custom.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".to_string())).join(".wazir")
}

#[cfg(target_os = "macos")]
fn dirs_log_dir() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default()).join("Library/Logs")
}

#[cfg(not(target_os = "macos"))]
fn dirs_log_dir() -> PathBuf {
    std::env::temp_dir()
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

/// Resolves the `node` binary across standard macOS/Linux locations so GUI launches
/// (which inherit a minimal `/usr/bin:/bin` PATH from launchd) can always spawn
/// `wazir-api` and `wazir-web`.
fn resolve_node_binary() -> String {
    if let Ok(explicit) = std::env::var("WAZIR_NODE_BIN") {
        if !explicit.trim().is_empty() && Path::new(explicit.trim()).exists() {
            return explicit.trim().to_string();
        }
    }
    let candidates = [
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
    ];
    for candidate in candidates {
        if Path::new(candidate).exists() {
            return candidate.to_string();
        }
    }
    "node".to_string()
}

fn is_listening(port: u16) -> bool {
    TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}").parse().expect("valid loopback addr"),
        Duration::from_millis(250),
    )
    .is_ok()
}

fn wait_until_listening(port: u16, timeout: Duration) -> bool {
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        if is_listening(port) {
            return true;
        }
        std::thread::sleep(HEALTH_POLL_INTERVAL);
    }
    is_listening(port)
}

#[derive(Default)]
struct OwnedBackend {
    api: Option<Child>,
    web: Option<Child>,
}

fn spawn_logged(
    cwd: &Path,
    args: &[&str],
    log_file: &Path,
    envs: &[(&str, &str)],
) -> std::io::Result<Child> {
    let log = std::fs::File::create(log_file)?;
    let err_log = log.try_clone()?;
    let node_bin = resolve_node_binary();
    let mut cmd = Command::new(node_bin);
    cmd.args(args)
        .current_dir(cwd)
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(err_log));
    for (key, value) in envs {
        cmd.env(key, value);
    }
    cmd.spawn()
}

fn generate_local_operator_token() -> String {
    let bytes: [u8; 32] = rand::thread_rng().gen();
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(target_os = "macos")]
fn read_keychain_token() -> Option<String> {
    let output = Command::new("/usr/bin/security")
        .args([
            "find-generic-password",
            "-s",
            KEYCHAIN_SERVICE,
            "-a",
            KEYCHAIN_ACCOUNT,
            "-w",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let token = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if token.len() >= 16 {
        Some(token)
    } else {
        None
    }
}

#[cfg(not(target_os = "macos"))]
fn read_keychain_token() -> Option<String> {
    None
}

#[cfg(target_os = "macos")]
fn store_keychain_token(token: &str) {
    let _ = Command::new("/usr/bin/security")
        .args([
            "add-generic-password",
            "-U",
            "-s",
            KEYCHAIN_SERVICE,
            "-a",
            KEYCHAIN_ACCOUNT,
            "-w",
            token,
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[cfg(not(target_os = "macos"))]
fn store_keychain_token(_token: &str) {}

/// Synchronizes the operator token across `~/.wazir/local-operator.token` (mode 0600)
/// and the OS keychain so `wazir-api`, `wazir-web`, and `wazir-desktop` always share
/// a deterministic credential even when one process is already running or restarts.
fn load_or_store_operator_token_in_dir(wazir_dir: &Path, use_keychain: bool) -> String {
    let _ = std::fs::create_dir_all(wazir_dir);
    let token_path = wazir_dir.join("local-operator.token");

    if let Ok(existing) = std::fs::read_to_string(&token_path) {
        let trimmed = existing.trim().to_string();
        if trimmed.len() >= 16 {
            if use_keychain {
                store_keychain_token(&trimmed);
            }
            return trimmed;
        }
    }

    let token = if use_keychain {
        read_keychain_token().unwrap_or_else(generate_local_operator_token)
    } else {
        generate_local_operator_token()
    };

    if let Ok(mut file) = std::fs::File::create(&token_path) {
        let _ = file.write_all(format!("{token}\n").as_bytes());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&token_path, std::fs::Permissions::from_mode(0o600));
        }
    }
    if use_keychain {
        store_keychain_token(&token);
    }
    token
}

fn start_local_runtime_if_needed(token: &str) -> OwnedBackend {
    let root = repo_root();
    let logs = logs_dir();
    let _ = std::fs::create_dir_all(&logs);
    let mut owned = OwnedBackend::default();

    if !is_listening(API_PORT) {
        match spawn_logged(
            &root.join("apps/api"),
            &["dist/main.js"],
            &logs.join("api.log"),
            &[("WAZIR_API_TOKEN", token)],
        ) {
            Ok(child) => owned.api = Some(child),
            Err(e) => eprintln!("Wazir Desktop: failed to start the local API ({e})"),
        }
    }
    if !is_listening(WEB_PORT) {
        match spawn_logged(
            &root.join("apps/web"),
            &["server.js"],
            &logs.join("web.log"),
            &[
                ("WAZIR_API_TOKEN", token),
                ("WAZIR_API", &format!("http://127.0.0.1:{API_PORT}")),
            ],
        ) {
            Ok(child) => owned.web = Some(child),
            Err(e) => eprintln!("Wazir Desktop: failed to start the local web dashboard ({e})"),
        }
    }
    owned
}

fn kill_owned(owned: &mut OwnedBackend) {
    if let Some(mut child) = owned.api.take() {
        let _ = child.kill();
    }
    if let Some(mut child) = owned.web.take() {
        let _ = child.kill();
    }
}

/// Sends a native OS notification when a high-risk tool approval is waiting for operator review.
fn send_system_notification(title: &str, body: &str) {
    #[cfg(target_os = "macos")]
    {
        let safe_title = title.replace('\\', "\\\\").replace('"', "\\\"");
        let safe_body = body.replace('\\', "\\\\").replace('"', "\\\"");
        let script = format!("display notification \"{safe_body}\" with title \"{safe_title}\"");
        let _ = Command::new("/usr/bin/osascript")
            .args(["-e", &script])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(target_os = "linux")]
    {
        let _ = Command::new("notify-send")
            .args([title, body])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

/// Lightweight HTTP GET over loopback to check for pending approvals without adding heavy HTTP crates.
fn check_pending_approvals(port: u16, token: &str) -> Vec<String> {
    let addr = match format!("127.0.0.1:{port}").parse() {
        Ok(a) => a,
        Err(_) => return Vec::new(),
    };
    let mut stream = match TcpStream::connect_timeout(&addr, Duration::from_millis(500)) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(1000)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
    let req = format!(
        "GET /api/v1/mobile/approvals?status=pending HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(req.as_bytes()).is_err() {
        return Vec::new();
    }
    let mut resp = String::new();
    if stream.read_to_string(&mut resp).is_err() {
        return Vec::new();
    }
    let body = match resp.split("\r\n\r\n").nth(1) {
        Some(b) => b,
        None => return Vec::new(),
    };
    let mut ids = Vec::new();
    for part in body.split("\"id\":\"") {
        if let Some(end) = part.find('"') {
            let candidate = &part[..end];
            if candidate.starts_with("apr-") || candidate.starts_with("approval-") {
                ids.push(candidate.to_string());
            }
        }
    }
    ids
}

fn build_menu(app: &tauri::AppHandle<Wry>) -> tauri::Result<Menu<Wry>> {
    let about = PredefinedMenuItem::about(app, None, None)?;
    let quit = PredefinedMenuItem::quit(app, None)?;
    let separator = PredefinedMenuItem::separator(app)?;

    let reload = MenuItem::with_id(app, "reload", "Reload Dashboard", true, Some("CmdOrCtrl+R"))?;
    let pair_host = MenuItem::with_id(app, "pair_host", "Pair or Switch Remote Host…", true, Some("CmdOrCtrl+Shift+H"))?;
    let host_local = MenuItem::with_id(app, "host_local", "Switch to Local Host", true, None::<&str>)?;
    let autonomy_readonly = MenuItem::with_id(app, "autonomy_readonly", "Autonomy: Read-Only (Strict)", true, None::<&str>)?;
    let autonomy_review = MenuItem::with_id(app, "autonomy_review", "Autonomy: Request-Review (Balanced)", true, None::<&str>)?;
    let autonomy_sandbox = MenuItem::with_id(app, "autonomy_sandbox", "Autonomy: Auto-Sandbox (Permissive)", true, None::<&str>)?;
    let manage_schedules = MenuItem::with_id(app, "manage_schedules", "Scheduled Tasks (@wazir/scheduler)", true, Some("CmdOrCtrl+Shift+S"))?;
    let open_browser = MenuItem::with_id(app, "open_browser", "Open in Browser", true, None::<&str>)?;
    let view_logs = MenuItem::with_id(app, "view_logs", "View Logs", true, None::<&str>)?;

    let app_menu = Submenu::with_items(app, "Wazir Desktop", true, &[&about, &separator, &quit])?;
    let view_menu = Submenu::with_items(app, "View", true, &[&reload, &manage_schedules])?;
    let control_menu = Submenu::with_items(
        app,
        "Control",
        true,
        &[
            &pair_host,
            &host_local,
            &separator,
            &autonomy_readonly,
            &autonomy_review,
            &autonomy_sandbox,
        ],
    )?;
    let help_menu = Submenu::with_items(app, "Help", true, &[&open_browser, &view_logs])?;

    Menu::with_items(app, &[&app_menu, &view_menu, &control_menu, &help_menu])
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(Mutex::new(OwnedBackend::default()))
        .setup(|app| {
            let menu = build_menu(app.handle())?;
            app.set_menu(menu)?;

            let token = load_or_store_operator_token_in_dir(&wazir_home_dir(), true);
            let owned = start_local_runtime_if_needed(&token);
            *app.state::<Mutex<OwnedBackend>>().lock().unwrap() = owned;

            let app_handle = app.handle().clone();
            let monitor_token = token.clone();
            std::thread::spawn(move || {
                // Wait for BOTH API_PORT (4800) and WEB_PORT (4801) so the first dashboard
                // request never hits an unready upstream with 502 Bad Gateway.
                let api_ready = wait_until_listening(API_PORT, HEALTH_TIMEOUT);
                let web_ready = wait_until_listening(WEB_PORT, HEALTH_TIMEOUT);
                let ready = api_ready && web_ready;
                if let Some(window) = app_handle.get_webview_window("main") {
                    if web_ready {
                        let _ = window.eval(&format!("window.location.replace('{DASHBOARD_URL}')"));
                    } else {
                        eprintln!(
                            "Wazir Desktop: local runtime did not come up on ports {API_PORT}/{WEB_PORT} within {:?}; showing the window anyway.",
                            HEALTH_TIMEOUT
                        );
                    }
                    let _ = window.show();
                    let _ = window.set_focus();
                    let _ = app_handle.emit("wazir://runtime-ready", ready);
                }

                // Background approval notification monitor
                let mut seen_approvals: HashSet<String> = HashSet::new();
                loop {
                    std::thread::sleep(Duration::from_secs(5));
                    for id in check_pending_approvals(API_PORT, &monitor_token) {
                        if seen_approvals.insert(id.clone()) {
                            send_system_notification(
                                "Wazir Approval Required",
                                &format!("Pending high-risk tool approval ({id}). Open Wazir Desktop to review."),
                            );
                            let _ = app_handle.emit("wazir://approval-pending", id);
                        }
                    }
                }
            });

            Ok(())
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "reload" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.eval("window.location.reload()");
                }
            }
            "pair_host" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.eval("window.__WAZIR_SURFACE__ && window.__WAZIR_SURFACE__.openPairHostDrawer()");
                }
            }
            "host_local" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.eval("window.__WAZIR_SURFACE__ && window.__WAZIR_SURFACE__.selectTargetHost('local')");
                }
            }
            "autonomy_readonly" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.eval("window.__WAZIR_SURFACE__ && window.__WAZIR_SURFACE__.setAutonomyPosture('read-only')");
                }
            }
            "autonomy_review" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.eval("window.__WAZIR_SURFACE__ && window.__WAZIR_SURFACE__.setAutonomyPosture('request-review')");
                }
            }
            "autonomy_sandbox" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.eval("window.__WAZIR_SURFACE__ && window.__WAZIR_SURFACE__.setAutonomyPosture('auto-sandbox')");
                }
            }
            "manage_schedules" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.eval("window.__WAZIR_SURFACE__ && window.__WAZIR_SURFACE__.switchTab('schedules')");
                }
            }
            "open_browser" => {
                let _ = app
                    .opener()
                    .open_url(DASHBOARD_URL, None::<&str>);
            }
            "view_logs" => {
                let _ = app.opener().reveal_item_in_dir(logs_dir());
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("error while building the Wazir Desktop application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit = event {
                kill_owned(&mut app_handle.state::<Mutex<OwnedBackend>>().lock().unwrap());
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn generates_64_hex_operator_token() {
        let token = generate_local_operator_token();
        assert_eq!(token.len(), 64);
        assert!(token.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn persists_and_reloads_operator_token_deterministically() {
        let tmp = std::env::temp_dir().join(format!("wazir-desktop-test-{}", generate_local_operator_token()));
        let first = load_or_store_operator_token_in_dir(&tmp, false);
        let second = load_or_store_operator_token_in_dir(&tmp, false);
        assert_eq!(first, second);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn resolves_node_binary_and_detects_listening_port() {
        let node = resolve_node_binary();
        assert!(!node.is_empty());

        let listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
        let port = listener.local_addr().unwrap().port();
        assert!(wait_until_listening(port, Duration::from_millis(500)));
        drop(listener);
    }
}
