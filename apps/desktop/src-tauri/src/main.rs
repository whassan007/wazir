#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Manager, Wry};
use tauri_plugin_opener::OpenerExt;

const WEB_PORT: &str = "4801";

fn logs_dir() -> std::path::PathBuf {
    // Mirrors the macOS launcher in scripts/build-dmg.sh so logs land in one
    // place regardless of which Wazir client started the servers.
    dirs_log_dir().join("Wazir")
}

#[cfg(target_os = "macos")]
fn dirs_log_dir() -> std::path::PathBuf {
    std::path::PathBuf::from(std::env::var("HOME").unwrap_or_default()).join("Library/Logs")
}

#[cfg(not(target_os = "macos"))]
fn dirs_log_dir() -> std::path::PathBuf {
    std::env::temp_dir()
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
        .setup(|app| {
            let menu = build_menu(app.handle())?;
            app.set_menu(menu)?;
            std::fs::create_dir_all(logs_dir()).ok();
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
                    .open_url(format!("http://127.0.0.1:{WEB_PORT}"), None::<&str>);
            }
            "view_logs" => {
                let _ = app.opener().reveal_item_in_dir(logs_dir());
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("error while running the Wazir Desktop application");
}
