#[cfg(target_os = "linux")]
mod layer_shell;

mod config;
mod lpk;
mod tray;

use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{Emitter, Manager};

pub struct PetWindowState {
    pub initialized: bool,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|_app, _args, _cwd| {}))
        .plugin(tauri_plugin_dialog::init())
        .register_uri_scheme_protocol("model", |_ctx, request| {
            // Serve model files from the filesystem via model:// protocol
            let uri = request.uri().to_string();
            // URI format: model://localhost/<absolute-path>
            let path = uri
                .strip_prefix("model://localhost/")
                .or_else(|| uri.strip_prefix("model://localhost"))
                .unwrap_or("");
            let path = percent_encoding::percent_decode_str(path)
                .decode_utf8_lossy()
                .to_string();

            let file_path = std::path::Path::new(&path);
            match std::fs::read(file_path) {
                Ok(mut data) => {
                    let mime = match file_path.extension().and_then(|e| e.to_str()) {
                        Some("json") => "application/json",
                        Some("moc3") | Some("moc") => "application/octet-stream",
                        Some("png") => "image/png",
                        Some("jpg") | Some("jpeg") => "image/jpeg",
                        Some("wav") => "audio/wav",
                        Some("ogg") => "audio/ogg",
                        Some("mp3") => "audio/mpeg",
                        Some("mtn") => "text/plain",
                        _ => "application/octet-stream",
                    };

                    // Patch model3.json
                    if path.ends_with(".model3.json") {
                        if let Ok(text) = std::str::from_utf8(&data) {
                            if let Ok(mut json) = serde_json::from_str::<serde_json::Value>(text) {
                                let mut patched_any = false;

                                // Add missing "Groups" field required by Cubism SDK
                                if json.get("FileReferences").is_some() && json.get("Groups").is_none() {
                                    json["Groups"] = serde_json::json!([]);
                                    patched_any = true;
                                }

                                // Remove empty texture entries — LPK extraction can leave
                                // empty strings which cause Assets.load("") to return a
                                // plain object instead of a Texture, crashing the renderer.
                                if let Some(textures) = json.pointer_mut("/FileReferences/Textures")
                                    .and_then(|v| v.as_array_mut())
                                {
                                    let before = textures.len();
                                    textures.retain(|v| {
                                        v.as_str().map_or(true, |s| !s.is_empty())
                                    });
                                    if textures.len() != before {
                                        patched_any = true;
                                    }
                                }

                                if patched_any {
                                    if let Ok(out) = serde_json::to_vec(&json) {
                                        data = out;
                                    }
                                }
                            }
                        }
                    }

                    // Patch motion3.json: fix incorrect TotalPointCount/TotalSegmentCount
                    // LPK-extracted motions have hashed filenames (.json, not .motion3.json),
                    // so detect by content structure rather than extension.
                    if mime == "application/json" {
                        if let Ok(text) = std::str::from_utf8(&data) {
                            if let Ok(mut json) = serde_json::from_str::<serde_json::Value>(text) {
                                if json.get("Meta").and_then(|m| m.get("TotalPointCount")).is_some()
                                    && json.get("Curves").and_then(|c| c.as_array()).is_some()
                                {
                                    let curves = json["Curves"].as_array().unwrap();
                                    let mut total_points: u64 = 0;
                                    let mut total_segments: u64 = 0;

                                    for curve in curves {
                                        if let Some(segs) = curve.get("Segments").and_then(|s| s.as_array()) {
                                            if segs.len() < 2 { continue; }
                                            total_points += 1; // initial point (time, value)
                                            let mut i = 2;
                                            while i < segs.len() {
                                                let seg_type = segs[i].as_f64().unwrap_or(-1.0) as i64;
                                                match seg_type {
                                                    0 | 2 | 3 => { // Linear / Stepped / InvStepped
                                                        total_points += 1;
                                                        total_segments += 1;
                                                        i += 3;
                                                    }
                                                    1 => { // Bezier
                                                        total_points += 3;
                                                        total_segments += 1;
                                                        i += 7;
                                                    }
                                                    _ => break,
                                                }
                                            }
                                        }
                                    }

                                    json["Meta"]["TotalPointCount"] = serde_json::json!(total_points);
                                    json["Meta"]["TotalSegmentCount"] = serde_json::json!(total_segments);
                                    if let Ok(patched) = serde_json::to_vec(&json) {
                                        data = patched;
                                    }
                                }
                            }
                        }
                    }

                    tauri::http::Response::builder()
                        .header("Content-Type", mime)
                        .header("Access-Control-Allow-Origin", "*")
                        .header("Access-Control-Allow-Methods", "GET, OPTIONS")
                        .header("Access-Control-Allow-Headers", "*")
                        .header("Cross-Origin-Resource-Policy", "cross-origin")
                        .body(data)
                        .unwrap()
                }
                Err(_) => tauri::http::Response::builder()
                    .status(404)
                    .body(b"Not found".to_vec())
                    .unwrap(),
            }
        })
        .manage(Mutex::new(PetWindowState { initialized: false }))
        .invoke_handler(tauri::generate_handler![
            load_model,
            get_config,
            get_model_preview,
            set_model_preview,
            apply_model,
            add_model,
            add_models_from_dir,
            remove_model,
            set_setting,
            update_input_region,
            open_settings,
            get_model_info,
            set_model_name,
            set_model_motions,
            get_model_names,
            get_custom_motions,
            js_log
        ]);

    // Manage the layer-shell window state (Linux only)
    #[cfg(target_os = "linux")]
    {
        builder = builder.manage(layer_shell::LayerShellWindow::new());
    }

    builder
        .setup(|app| {
            let handle = app.handle().clone();
            tray::setup_tray(&handle)?;

            let cfg = config::load(&handle);
            eprintln!("[rive2d] current_model = {:?}", cfg.current_model);
            eprintln!("[rive2d] models = {:?}", cfg.models);
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
    if let Some(window) = app.get_webview_window("config") {
        window.show().ok();
        window.set_focus().ok();
        return;
    }

    // Build the config page URL
    let url = {
        let dev_url = &app.config().build.dev_url;
        if let Some(base) = dev_url {
            let full = format!("{}config.html", base);
            eprintln!("[rive2d] Config window URL: {}", full);
            tauri::WebviewUrl::External(full.parse().unwrap())
        } else {
            eprintln!("[rive2d] Config window URL: tauri://localhost/config.html");
            tauri::WebviewUrl::App("config.html".into())
        }
    };

    let config_window = tauri::WebviewWindowBuilder::new(app, "config", url)
        .title("Rive2d Settings")
        .inner_size(1024.0, 1024.0)
        .resizable(false)
        .build()
        .expect("Failed to create config window");

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
async fn add_model(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err("File not found".to_string());
    }

    let hash = file_md5(p)?;
    if config::has_hash(&app, &hash) {
        return Err("Model already imported".to_string());
    }

    let model_path = match p.extension().and_then(|e| e.to_str()) {
        Some("lpk") => extract_lpk(&app, &path)?,
        Some("json") => path,
        _ => return Err("Unsupported format. Use .lpk or .model3.json".to_string()),
    };

    config::add_model(&app, &model_path, Some(&hash));
    Ok(())
}

fn file_md5(path: &std::path::Path) -> Result<String, String> {
    let data = std::fs::read(path).map_err(|e| e.to_string())?;
    Ok(format!("{:x}", md5::compute(&data)))
}

fn extract_lpk(app: &tauri::AppHandle, lpk_path: &str) -> Result<String, String> {
    let lpk = std::path::Path::new(lpk_path);
    let stem = lpk
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or("Invalid file name")?;

    let models_dir = app
        .path()
        .app_data_dir()
        .expect("Failed to get app data dir")
        .join("models")
        .join(stem);

    lpk::extract_lpk(&models_dir, lpk_path)
}

#[derive(serde::Serialize)]
struct ImportResult {
    imported: u32,
    skipped: u32,
    errors: Vec<String>,
}

#[derive(serde::Serialize, Clone)]
struct ImportProgress {
    current: u32,
    total: u32,
    name: String,
}

#[tauri::command]
async fn add_models_from_dir(app: tauri::AppHandle, path: String) -> Result<ImportResult, String> {
    let dir = std::path::Path::new(&path);
    if !dir.is_dir() {
        return Err("Not a directory".to_string());
    }

    // Phase 1: collect all .lpk paths
    let mut lpk_files = Vec::new();
    collect_lpk_files(dir, 0, 5, &mut lpk_files);

    if lpk_files.is_empty() {
        return Err("No .lpk files found".to_string());
    }

    let total = lpk_files.len() as u32;
    let mut imported = 0u32;
    let mut skipped = 0u32;
    let mut errors = Vec::new();

    // Phase 2: process with progress events
    for (i, lpk_path) in lpk_files.iter().enumerate() {
        let name = lpk_path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();

        app.emit(
            "import-progress",
            ImportProgress {
                current: i as u32 + 1,
                total,
                name: name.clone(),
            },
        )
        .ok();

        let path_str = lpk_path.to_string_lossy().to_string();
        let hash = match file_md5(lpk_path) {
            Ok(h) => h,
            Err(_) => continue,
        };
        if config::has_hash(&app, &hash) {
            skipped += 1;
            continue;
        }
        match extract_lpk(&app, &path_str) {
            Ok(model_path) => {
                config::add_model(&app, &model_path, Some(&hash));
                imported += 1;
            }
            Err(e) => {
                errors.push(format!("{}: {}", name, e));
            }
        }
    }

    Ok(ImportResult {
        imported,
        skipped,
        errors,
    })
}

fn collect_lpk_files(
    dir: &std::path::Path,
    depth: u32,
    max_depth: u32,
    out: &mut Vec<std::path::PathBuf>,
) {
    if depth > max_depth {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_lpk_files(&path, depth + 1, max_depth, out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("lpk") {
            out.push(path);
        }
    }
}

#[tauri::command]
fn remove_model(app: tauri::AppHandle, path: String) -> Result<(), String> {
    config::remove_model(&app, &path);
    Ok(())
}

#[tauri::command]
async fn apply_model(app: tauri::AppHandle, path: String) -> Result<(), String> {
    config::set_model(&app, &path);

    // Clear old model's position/scale so new model starts centered
    config::delete_settings(&app, &["model_x", "model_y", "model_scale"]);

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
fn set_setting(app: tauri::AppHandle, key: String, value: String) {
    config::set_setting(&app, &key, &value);
    app.emit("setting-changed", (&key, &value)).ok();
}

/// Given a model JSON path, return the absolute path to a preview image.
/// Checks for a user-uploaded preview first, then falls back to the model's first texture.
#[tauri::command]
fn get_model_preview(app: tauri::AppHandle, path: String) -> Option<String> {
    // Check for custom preview in DB
    let custom = config::get_setting(&app, &format!("preview:{}", path));
    if let Some(ref p) = custom {
        if std::path::Path::new(p).exists() {
            return custom;
        }
    }

    // Fall back to first texture from model JSON
    let model_path = std::path::Path::new(&path);
    let dir = model_path.parent()?;
    let json_str = std::fs::read_to_string(model_path).ok()?;
    let json: serde_json::Value = serde_json::from_str(&json_str).ok()?;

    let texture = json
        .get("textures")
        .and_then(|v| v.as_array())
        .and_then(|a| a.first())
        .and_then(|v| v.as_str())
        .or_else(|| {
            json.get("FileReferences")
                .and_then(|fr| fr.get("Textures"))
                .and_then(|v| v.as_array())
                .and_then(|a| a.first())
                .and_then(|v| v.as_str())
        })?;

    let abs = dir.join(texture);
    if abs.exists() {
        Some(abs.to_string_lossy().into_owned())
    } else {
        None
    }
}

#[tauri::command]
fn set_model_preview(app: tauri::AppHandle, model_path: String, image_path: String) -> Result<(), String> {
    if !std::path::Path::new(&image_path).exists() {
        return Err("Image file not found".to_string());
    }
    config::set_setting(&app, &format!("preview:{}", model_path), &image_path);
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

#[tauri::command]
fn update_input_region(app: tauri::AppHandle, x: i32, y: i32, width: i32, height: i32) {
    #[cfg(target_os = "linux")]
    {
        let handle = app.clone();
        gtk::glib::idle_add_once(move || {
            let state = handle.state::<layer_shell::LayerShellWindow>();
            if let Some(window) = state.get() {
                layer_shell::update_input_region(&window, x, y, width, height);
            }
        });
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, x, y, width, height);
    }
}

#[tauri::command]
fn open_settings(app: tauri::AppHandle) {
    create_config_window(&app);
}

#[derive(serde::Serialize)]
struct HitAreaInfo {
    name: String,
    id: String,
    default_motion: Option<String>,
}

#[derive(serde::Serialize)]
struct ModelInfo {
    hit_areas: Vec<HitAreaInfo>,
    motion_groups: Vec<String>,
    custom_name: Option<String>,
    custom_motions: Option<String>,
}

#[tauri::command]
fn get_model_info(app: tauri::AppHandle, path: String) -> Result<ModelInfo, String> {
    let json_str = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let json: serde_json::Value = serde_json::from_str(&json_str).map_err(|e| e.to_string())?;

    let mut hit_areas = Vec::new();
    let mut motion_groups = Vec::new();

    // Cubism 3/4: HitAreas with {Name, Id, Motion}
    if let Some(areas) = json.get("HitAreas").and_then(|v| v.as_array()) {
        for area in areas {
            let name = area
                .get("Name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let id = area
                .get("Id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let motion = area
                .get("Motion")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            hit_areas.push(HitAreaInfo {
                name,
                id,
                default_motion: motion,
            });
        }
    }

    // Cubism 2: hit_areas with {name, id}
    if hit_areas.is_empty() {
        if let Some(areas) = json.get("hit_areas").and_then(|v| v.as_array()) {
            for area in areas {
                let name = area
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let id = area
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                hit_areas.push(HitAreaInfo {
                    name,
                    id,
                    default_motion: None,
                });
            }
        }
    }

    // Motion groups - Cubism 3/4
    if let Some(motions) = json
        .get("FileReferences")
        .and_then(|fr| fr.get("Motions"))
        .and_then(|v| v.as_object())
    {
        motion_groups = motions.keys().cloned().collect();
    }
    // Motion groups - Cubism 2
    if motion_groups.is_empty() {
        if let Some(motions) = json.get("motions").and_then(|v| v.as_object()) {
            motion_groups = motions.keys().cloned().collect();
        }
    }
    motion_groups.sort();

    let custom_name = config::get_setting(&app, &format!("name:{}", path));
    let custom_motions = config::get_setting(&app, &format!("motions:{}", path));

    Ok(ModelInfo {
        hit_areas,
        motion_groups,
        custom_name,
        custom_motions,
    })
}

#[tauri::command]
fn set_model_name(app: tauri::AppHandle, path: String, name: String) {
    let key = format!("name:{}", path);
    if name.is_empty() {
        config::delete_settings(&app, &[&key]);
    } else {
        config::set_setting(&app, &key, &name);
    }
}

#[tauri::command]
fn set_model_motions(app: tauri::AppHandle, path: String, mappings: String) {
    let key = format!("motions:{}", path);
    if mappings == "{}" || mappings.is_empty() {
        config::delete_settings(&app, &[&key]);
    } else {
        config::set_setting(&app, &key, &mappings);
    }
    app.emit("motions-changed", &path).ok();
}

#[tauri::command]
fn get_model_names(app: tauri::AppHandle, paths: Vec<String>) -> HashMap<String, String> {
    let mut result = HashMap::new();
    for path in paths {
        if let Some(name) = config::get_setting(&app, &format!("name:{}", path)) {
            result.insert(path, name);
        }
    }
    result
}

#[tauri::command]
fn get_custom_motions(app: tauri::AppHandle, path: String) -> Option<String> {
    config::get_setting(&app, &format!("motions:{}", path))
}

#[tauri::command]
fn js_log(level: String, msg: String) {
    eprintln!("[rive2d:js:{}] {}", level, msg);
    use std::io::Write;
    // Tauri dev runs from src-tauri/, go up one level to project root
    let log_path = std::env::current_dir()
        .unwrap_or_default()
        .join("../rive2d.log");
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
    {
        let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
        writeln!(f, "[{}] [{}] {}", now, level, msg).ok();
    }
}
