# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Rive2d is a Linux/Wayland desktop pet that displays Live2D models as transparent overlays using Tauri 2 (Rust) + PixiJS 8 + Wayland layer-shell.

## Commands

```sh
make dev          # Dev mode (dynamic port, Vite + Tauri hot-reload)
make build        # Production binary
make install      # Install all deps (pnpm + cargo fetch)
make check        # Rust type-check only
make fmt           # cargo fmt
make clippy        # cargo clippy
make clean         # Remove dist + target
make distclean     # Also remove node_modules
```

Rust-only build: `cd src-tauri && cargo build`

## Architecture

Two windows, one Rust backend:

- **Pet window** (`src/index.html` → `src/main.js`): Fullscreen transparent layer-shell overlay. PixiJS 8 renders a Live2D model via `untitled-pixi-live2d-engine`. Draggable, resizable (scroll wheel). GDK input region restricts clicks to the model bounds; empty areas pass through to the desktop.

- **Settings window** (`src/config.html` → `src/config/App.vue`): Vue 3 SFC app for model import/removal and settings. Uses hide-on-close pattern so the tray can reopen it without reconstructing.

- **Backend** (`src-tauri/src/`): Tauri 2 app with SQLite config, system tray, LPK decryption, `model://` URI protocol for serving model files, and layer-shell window management.

### Rust Modules

| Module | Purpose |
|---|---|
| `lib.rs` | Tauri builder, commands (`get_config`, `apply_model`, `set_setting`, `update_input_region`, etc.), config window creation |
| `layer_shell.rs` | Linux-only. Creates fullscreen transparent GTK window anchored to all edges via `gtk-layer-shell`. Manages GDK input regions. Frame-by-frame `queue_draw()` to prevent Wayland smearing |
| `config.rs` | SQLite storage (`config` KV table + `models` list table). `AppConfig` struct serialized to frontend |
| `tray.rs` | System tray with Settings/Quit menu items |
| `lpk.rs` | Extracts Live2DViewerEX `.lpk` archives (regular ZIP or encrypted STM/STD formats with LCG XOR cipher) |

### IPC Flow

- **Frontend → Backend**: `window.__TAURI__.core.invoke('command_name', {args})` for mutations
- **Backend → Frontend**: `app.emit("event-name", payload)` for notifications (`load-model`, `setting-changed`)
- Event listeners in `main.js` are registered synchronously *before* the async `app.init()` to avoid missing the backend's delayed `load-model` emit

### Model Loading Pipeline

1. User imports `.lpk` or `.model3.json` via settings window
2. LPK files are extracted/decrypted to `app_data_dir/models/<stem>/`
3. `apply_model` command stores path in SQLite, initializes layer-shell if first model, emits `load-model`
4. Frontend receives event, loads model via `Live2DModel.from('model://localhost/' + path)`
5. `model://` protocol handler in Rust serves files from the filesystem with correct MIME types

## Critical Platform Details

**Wayland/Niri**: Must use `127.0.0.1` (not `localhost`) for devUrl and Vite host. WebKitGTK resolves localhost differently inside its sandbox. Also requires `WEBKIT_DISABLE_DMABUF_RENDERER=1` env var.

**Layer shell threading**: All GTK operations must run on the GTK main thread. Use `gtk::glib::idle_add_once()` when dispatching from Tauri async commands.

**PixiJS 8 in WebKitGTK**: Must set `preference: 'webgl'` — WebKitGTK has no WebGPU support. Application init is async (`await app.init({...})`).

**Live2D library**: `untitled-pixi-live2d-engine` supports Cubism 2-4 with PixiJS 8. The `@naari3/pixi-live2d-display` fork only supports Cubism 5. The original `pixi-live2d-display` only works with PixiJS 6/7.

**Rust state access**: `app.state::<T>()` returns a temporary — bind to a `let` before calling `.lock()`. Required trait imports: `tauri::Emitter` for `emit()`, `tauri::Manager` for `get_webview_window()`/`state()`.

**Dynamic dev port**: `make dev` finds a free port at runtime and passes it to both Vite and Tauri via `--config` override, avoiding hardcoded port conflicts.
