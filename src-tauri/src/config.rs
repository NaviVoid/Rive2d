use rusqlite::Connection;
use serde::Serialize;
use std::path::PathBuf;
use tauri::Manager;

#[derive(Debug, Clone, Serialize)]
pub struct AppConfig {
    pub current_model: Option<String>,
    pub models: Vec<String>,
    pub show_border: bool,
    pub model_x: Option<f64>,
    pub model_y: Option<f64>,
    pub model_scale: Option<f64>,
    pub tap_motion: bool,
    pub show_hit_areas: bool,
    pub lock_model: bool,
}

fn db_path(app: &tauri::AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_data_dir()
        .expect("Failed to get app data dir");
    std::fs::create_dir_all(&dir).ok();
    dir.join("rive2d.db")
}

fn open_db(app: &tauri::AppHandle) -> Connection {
    let path = db_path(app);
    let conn = Connection::open(path).expect("Failed to open database");
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS config (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS models (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            path TEXT NOT NULL UNIQUE,
            added_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );",
    )
    .expect("Failed to initialize database");
    conn
}

pub fn load(app: &tauri::AppHandle) -> AppConfig {
    let conn = open_db(app);

    let current_model: Option<String> = conn
        .query_row(
            "SELECT value FROM config WHERE key = 'current_model'",
            [],
            |row| row.get(0),
        )
        .ok();

    let mut stmt = conn
        .prepare("SELECT path FROM models ORDER BY added_at DESC")
        .unwrap();
    let models: Vec<String> = stmt
        .query_map([], |row| row.get(0))
        .unwrap()
        .filter_map(|r| r.ok())
        .collect();

    let show_border: bool = conn
        .query_row(
            "SELECT value FROM config WHERE key = 'show_border'",
            [],
            |row| row.get::<_, String>(0),
        )
        .map(|v| v == "true")
        .unwrap_or(false);

    let model_x: Option<f64> = conn
        .query_row(
            "SELECT value FROM config WHERE key = 'model_x'",
            [],
            |row| row.get::<_, String>(0),
        )
        .ok()
        .and_then(|v| v.parse().ok());

    let model_y: Option<f64> = conn
        .query_row(
            "SELECT value FROM config WHERE key = 'model_y'",
            [],
            |row| row.get::<_, String>(0),
        )
        .ok()
        .and_then(|v| v.parse().ok());

    let model_scale: Option<f64> = conn
        .query_row(
            "SELECT value FROM config WHERE key = 'model_scale'",
            [],
            |row| row.get::<_, String>(0),
        )
        .ok()
        .and_then(|v| v.parse().ok());

    let tap_motion: bool = conn
        .query_row(
            "SELECT value FROM config WHERE key = 'tap_motion'",
            [],
            |row| row.get::<_, String>(0),
        )
        .map(|v| v == "true")
        .unwrap_or(true);

    let show_hit_areas: bool = conn
        .query_row(
            "SELECT value FROM config WHERE key = 'show_hit_areas'",
            [],
            |row| row.get::<_, String>(0),
        )
        .map(|v| v == "true")
        .unwrap_or(false);

    let lock_model: bool = conn
        .query_row(
            "SELECT value FROM config WHERE key = 'lock_model'",
            [],
            |row| row.get::<_, String>(0),
        )
        .map(|v| v == "true")
        .unwrap_or(false);

    AppConfig {
        current_model,
        models,
        show_border,
        model_x,
        model_y,
        model_scale,
        tap_motion,
        show_hit_areas,
        lock_model,
    }
}

pub fn add_model(app: &tauri::AppHandle, path: &str) {
    let conn = open_db(app);
    conn.execute("INSERT OR IGNORE INTO models (path) VALUES (?1)", [path])
        .ok();
}

pub fn remove_model(app: &tauri::AppHandle, path: &str) {
    let conn = open_db(app);
    conn.execute("DELETE FROM models WHERE path = ?1", [path])
        .ok();

    // Clear current_model if it was the removed one
    let current: Option<String> = conn
        .query_row(
            "SELECT value FROM config WHERE key = 'current_model'",
            [],
            |row| row.get(0),
        )
        .ok();
    if current.as_deref() == Some(path) {
        conn.execute("DELETE FROM config WHERE key = 'current_model'", [])
            .ok();
    }
}

pub fn get_setting(app: &tauri::AppHandle, key: &str) -> Option<String> {
    let conn = open_db(app);
    conn.query_row(
        "SELECT value FROM config WHERE key = ?1",
        [key],
        |row| row.get(0),
    )
    .ok()
}

pub fn set_setting(app: &tauri::AppHandle, key: &str, value: &str) {
    let conn = open_db(app);
    conn.execute(
        "INSERT OR REPLACE INTO config (key, value) VALUES (?1, ?2)",
        [key, value],
    )
    .ok();
}

pub fn delete_settings(app: &tauri::AppHandle, keys: &[&str]) {
    let conn = open_db(app);
    for key in keys {
        conn.execute("DELETE FROM config WHERE key = ?1", [key]).ok();
    }
}

pub fn set_model(app: &tauri::AppHandle, path: &str) {
    let conn = open_db(app);
    conn.execute(
        "INSERT OR REPLACE INTO config (key, value) VALUES ('current_model', ?1)",
        [path],
    )
    .ok();
    conn.execute("INSERT OR IGNORE INTO models (path) VALUES (?1)", [path])
        .ok();
}
