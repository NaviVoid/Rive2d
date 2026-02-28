# Rive2d

A Linux/Wayland desktop pet that displays Live2D models as transparent overlays.

Only tested on my Archlinux niri desktop.

Built with Tauri 2 (Rust) + PixiJS 8 + Vue 3. Supports Cubism 2-4 models via `untitled-pixi-live2d-engine`.

![Screenshot](docs/Screenshot.png)

## Features

- **Transparent overlay** — fullscreen layer-shell window, clicks pass through to the desktop
- **Model interaction** — drag to move, scroll to resize, tap hit areas to trigger motions
- **ParamHit drag** — drag on hit areas to control Live2D parameters (Live2DViewerEX feature)
- **Animation system** — idle loop, start animation, motion chaining (NextMtn), random motion selection
- **Mouse tracking** — model gaze follows the cursor
- **LPK import** — extract `.lpk` packages (regular, STM, STD formats)
- **Batch import** — import an entire folder of models at once
- **Settings window** — model management, custom names, preview images, per-hit-area motion mapping with test buttons
- **System tray** — quick access to settings and quit
- **Right-click menu** — toggle tap motions, hit area display, mouse tracking, model lock, debug border
- **HiDPI rendering** — renders at native device pixel ratio for sharp edges
- **Config persistence** — position, scale, and settings saved in SQLite

## Requirements

- Linux with Wayland compositor
- Node.js + pnpm
- Rust toolchain
- System libraries: `gtk3`, `webkit2gtk`, `gtk-layer-shell`
- Sound libraries: `gst-plugins-base`, `gst-plugins-good`

## Setup

```sh
make install    # install pnpm + cargo dependencies
make dev        # run in dev mode with hot-reload
make build      # build production binary
```

## Commands

| Command          | Description                               |
| ---------------- | ----------------------------------------- |
| `make dev`       | Dev mode (dynamic port, Vite + Tauri HMR) |
| `make build`     | Production binary                         |
| `make install`   | Install all dependencies                  |
| `make check`     | Rust type-check only                      |
| `make fmt`       | Format Rust code                          |
| `make clippy`    | Run Rust linter                           |
| `make clean`     | Remove dist + target                      |
| `make distclean` | Also remove node_modules                  |

## Architecture

Two windows, one Rust backend:

- **Pet window** (`src/main.js`) — fullscreen transparent PixiJS 8 canvas rendering the Live2D model with drag, resize, tap, and parameter drag interactions
- **Settings window** (`src/config/App.vue`) — Vue 3 app for model import/removal, custom motion mapping, and global settings

### Rust Modules

| Module           | Purpose                                            |
| ---------------- | -------------------------------------------------- |
| `lib.rs`         | Tauri commands, `model://` protocol, config window |
| `layer_shell.rs` | Wayland layer-shell overlay + GDK input regions    |
| `config.rs`      | SQLite config storage                              |
| `lpk.rs`         | LPK archive extraction and decryption              |
| `tray.rs`        | System tray menu                                   |

## Known Issues

- Drag trigger (ParamHit MaxMtn) not working on some models
- Idle loop animation sometimes stops unexpectedly
- Clicking a hit area only triggers one motion

## License

MIT
