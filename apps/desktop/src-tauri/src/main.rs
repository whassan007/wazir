#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Emitter, Manager, Wry};
use tauri_plugin_opener::OpenerExt;

const WEB_PORT: u16 = 4801;
const API_PORT: u16 = 4800;
const DASHBOARD_URL: &str = "http://127.0.0.1:4801";
const HEALTH_TIMEOUT: Duration = Duration::from_secs(20);
const HEALTH_POLL_INTERVAL: Duration = Duration::from_millis(200);

fn logs_dir() -> PathBuf {
    // Mirrors the macOS launcher in scripts/build-dmg.sh so logs land in one
    // place regardless of which Wazir client started the servers.
    dirs_log_dir().join("Wazir")
}

#[cfg(target_os = "macos")]
fn dirs_log_dir() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default()).join("Library/Logs")
}

#[cfg(not(target_os = "macos"))]
fn dirs_log_dir() -> PathBuf {
    std::env::temp_dir()
}

/// The repo checkout this binary was built from. There is no bundled/sidecar Node
/// runtime yet (see apps/desktop/src-tauri/tauri.conf.json: `bundle.targets` is
/// empty and `desktop:build` passes `--no-bundle`) — this app is only distributed
/// as a dev-machine binary today, so resolving the API/web servers next to the
/// source tree they were built from is correct for now. Revisit this once Wazir
/// Desktop ships as a signed, resource-bundled installer.
fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
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

/// Child processes this instance of Wazir Desktop spawned itself. Only these —
/// never a runtime the user already had running before launch, and never a
/// remote runtime — are killed when the app quits.
#[derive(Default)]
struct OwnedBackend {
    api: Option<Child>,
    web: Option<Child>,
}

fn spawn_logged(cwd: &std::path::Path, args: &[&str], log_file: &std::path::Path) -> std::io::Result<Child> {
    let log = std::fs::File::create(log_file)?;
    let err_log = log.try_clone()?;
    Command::new("node")
        .args(args)
        .current_dir(cwd)
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(err_log))
        .spawn()
}

/// Starts the local API and/or web dashboard if nothing is already listening on
/// their ports. Logs go to the same `~/Library/Logs/Wazir` directory the legacy
/// CLI launcher (scripts/build-dmg.sh) uses, so "View Logs" shows real output
/// instead of an empty folder.
fn start_local_runtime_if_needed() -> OwnedBackend {
    let root = repo_root();
    let logs = logs_dir();
    let _ = std::fs::create_dir_all(&logs);
    let mut owned = OwnedBackend::default();

    if !is_listening(API_PORT) {
        match spawn_logged(&root.join("apps/api"), &["dist/main.js"], &logs.join("api.log")) {
            Ok(child) => owned.api = Some(child),
            Err(e) => eprintln!("Wazir Desktop: failed to start the local API ({e}); is Node on PATH and has `npm run build` been run?"),
        }
    }
    if !is_listening(WEB_PORT) {
        match spawn_logged(&root.join("apps/web"), &["server.js"], &logs.join("web.log")) {
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

fn build_menu(app: &tauri::AppHandle<Wry>) -> tauri::Result<Menu<Wry>> {
    let about = PredefinedMenuItem::about(app, None, None)?;
    let quit = PredefinedMenuItem::quit(app, None)?;
    let separator = PredefinedMenuItem::separator(app)?;

    let reload = MenuItem::with_id(app, "reload", "Reload Dashboard", true, Some("CmdOrCtrl+R"))?;
    let open_browser = MenuItem::with_id(app, "open_browser", "Open in Browser", true, None::<&str>)?;
    let view_logs = MenuItem::with_id(app, "view_logs", "View Logs", true, None::<&str>)?;

    let app_menu = Submenu::with_items(app, "Wazir Desktop", true, &[&about, &separator, &quit])?;
    let view_menu = Submenu::with_items(app, "View", true, &[&reload])?;
    let help_menu = Submenu::with_items(app, "Help", true, &[&open_browser, &view_logs])?;

    Menu::with_items(app, &[&app_menu, &view_menu, &help_menu])
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(Mutex::new(OwnedBackend::default()))
        .setup(|app| {
            let menu = build_menu(app.handle())?;
            app.set_menu(menu)?;

            let owned = start_local_runtime_if_needed();
            *app.state::<Mutex<OwnedBackend>>().lock().unwrap() = owned;

            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                let ready = wait_until_listening(WEB_PORT, HEALTH_TIMEOUT);
                if let Some(window) = app_handle.get_webview_window("main") {
                    if ready {
                        let _ = window.eval(&format!("window.location.replace('{DASHBOARD_URL}')"));
                    } else {
                        eprintln!(
                            "Wazir Desktop: local runtime did not come up on port {WEB_PORT} within {:?}; showing the window anyway.",
                            HEALTH_TIMEOUT
                        );
                    }
                    let _ = window.show();
                    let _ = window.set_focus();
                    let _ = app_handle.emit("wazir://runtime-ready", ready);
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
