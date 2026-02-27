use rusqlite::Connection;
use serde::Serialize;
use std::path::PathBuf;
use tauri::Manager;

#[derive(Debug, Clone, Serialize)]
pub struct AppConfig {
    pub current_model: Option<String>,
    pub models: Vec<String>,
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

    AppConfig {
        current_model,
        models,
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
