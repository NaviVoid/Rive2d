use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AppConfig {
    pub current_model: Option<String>,
    pub recent_models: Vec<String>,
}

fn config_path(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .expect("Failed to get app data dir")
        .join("config.json")
}

pub fn load(app: &tauri::AppHandle) -> AppConfig {
    let path = config_path(app);
    if path.exists() {
        let data = fs::read_to_string(&path).unwrap_or_default();
        serde_json::from_str(&data).unwrap_or_default()
    } else {
        AppConfig::default()
    }
}

pub fn save(app: &tauri::AppHandle, config: &AppConfig) {
    let path = config_path(app);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).ok();
    }
    let data = serde_json::to_string_pretty(config).expect("Failed to serialize config");
    fs::write(&path, data).expect("Failed to write config");
}

pub fn set_model(config: &mut AppConfig, path: &str) {
    config.current_model = Some(path.to_string());
    config.recent_models.retain(|p| p != path);
    config.recent_models.insert(0, path.to_string());
    config.recent_models.truncate(10);
}
