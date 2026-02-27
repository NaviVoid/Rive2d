#[cfg(target_os = "linux")]
mod layer_shell;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![load_model])
        .setup(|app| {
            #[cfg(target_os = "linux")]
            layer_shell::setup_layer_shell(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
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
