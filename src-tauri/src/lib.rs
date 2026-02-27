#[cfg(target_os = "linux")]
mod layer_shell;

mod config;
mod tray;

use std::sync::Mutex;
use tauri::{Emitter, Manager};

pub struct PetWindowState {
    pub initialized: bool,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Mutex::new(PetWindowState { initialized: false }))
        .invoke_handler(tauri::generate_handler![load_model, get_config, apply_model])
        .setup(|app| {
            let handle = app.handle().clone();
            tray::setup_tray(&handle)?;

            let cfg = config::load(&handle);
            if let Some(ref model_path) = cfg.current_model {
                // Has saved model: launch pet window immediately
                #[cfg(target_os = "linux")]
                layer_shell::setup_layer_shell(app)?;

                {
                    let state = handle.state::<Mutex<PetWindowState>>();
                    let mut state = state.lock().unwrap();
                    state.initialized = true;
                }

                // Emit load-model event after a short delay for webview to initialize
                let path = model_path.clone();
                let h = handle.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    h.emit("load-model", &path).ok();
                });
            } else {
                // No model saved: show config window
                create_config_window(&handle);
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

pub fn create_config_window(app: &tauri::AppHandle) {
    // If already exists, just show and focus it
    if let Some(window) = app.get_webview_window("config") {
        window.show().ok();
        window.set_focus().ok();
        return;
    }

    let config_window = tauri::WebviewWindowBuilder::new(
        app,
        "config",
        tauri::WebviewUrl::App("config.html".into()),
    )
    .title("Rive2d Settings")
    .inner_size(480.0, 400.0)
    .resizable(false)
    .build()
    .expect("Failed to create config window");

    // Hide instead of destroy on close
    let win = config_window.clone();
    config_window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            win.hide().ok();
        }
    });
}

#[tauri::command]
fn get_config(app: tauri::AppHandle) -> config::AppConfig {
    config::load(&app)
}

#[tauri::command]
async fn apply_model(app: tauri::AppHandle, path: String) -> Result<(), String> {
    // Save config
    let mut cfg = config::load(&app);
    config::set_model(&mut cfg, &path);
    config::save(&app, &cfg);

    // Initialize layer shell if not yet done
    let needs_init = {
        let state = app.state::<Mutex<PetWindowState>>();
        let mut state = state.lock().unwrap();
        if !state.initialized {
            state.initialized = true;
            true
        } else {
            false
        }
    };

    if needs_init {
        #[cfg(target_os = "linux")]
        {
            let handle = app.clone();
            gtk::glib::idle_add_once(move || {
                layer_shell::setup_layer_shell_from_handle(&handle)
                    .expect("Failed to setup layer shell");
            });
        }
    }

    // Emit model load event after a short delay for webview to initialize
    let path_clone = path.clone();
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(500));
        handle.emit("load-model", &path_clone).ok();
    });

    // Hide config window
    if let Some(config_win) = app.get_webview_window("config") {
        config_win.hide().map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
fn load_model(path: String) -> Result<String, String> {
    let path = std::path::Path::new(&path);
    if !path.exists() {
        return Err("Model file not found".to_string());
    }
    match path.extension().and_then(|e| e.to_str()) {
        Some("json") => std::fs::read_to_string(path).map_err(|e| e.to_string()),
        _ => Err("Invalid model file format".to_string()),
    }
}
