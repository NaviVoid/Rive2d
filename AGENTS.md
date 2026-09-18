# Repository Guidelines

## Project Structure & Module Organization

Rive2d is a Tauri 2 desktop pet for Linux/Wayland. Frontend source lives in `src/`: `main.ts` drives the PixiJS pet window, while `config/App.vue` implements the Vue settings window. Shared styles and HTML entry points are also under `src/`. Rust backend code is in `src-tauri/src/`; keep Tauri commands and protocol setup in `lib.rs`, persistence in `config.rs`, LPK handling in `lpk.rs`, Wayland integration in `layer_shell.rs`, and tray behavior in `tray.rs`. Documentation and screenshots belong in `docs/`. Treat `dist/`, `node_modules/`, and `src-tauri/target/` as generated output.

## Build, Test, and Development Commands

- `make install`: install pnpm packages and fetch Cargo dependencies.
- `make dev`: start Vite and the Tauri application with hot reload on a free local port.
- `make build`: produce a release bundle.
- `make check`: type-check the Rust backend.
- `make fmt`: format Rust sources with `rustfmt`.
- `make clippy`: run Rust lints.
- `cd src-tauri && cargo test`: run Rust unit tests.

Development requires Node.js, pnpm, Rust, GTK 3, WebKitGTK, and `gtk-layer-shell`; see `README.md` for the complete Linux requirements.

## Coding Style & Naming Conventions

Use four-space indentation and `rustfmt` defaults for Rust. Name Rust functions and modules with `snake_case`, and types with `PascalCase`. Follow the existing frontend style: two-space indentation, semicolons, `camelCase` JavaScript identifiers, and `PascalCase` Vue components. Keep changes localized to the owning module and avoid editing generated assets.

## Testing Guidelines

Rust tests currently live beside their implementation in `#[cfg(test)]` modules; use descriptive behavior names such as `encrypted_lpk_cannot_escape_destination`. Add focused regression tests for parsers, archive handling, persistence, and security boundaries. There is no JavaScript test runner yet, so manually exercise affected pet and settings workflows with `make dev`.

## Commit & Pull Request Guidelines

Recent commits use short, lowercase, imperative summaries such as `fix black texture` and `add preview image upload`. Keep each commit focused. Pull requests should describe behavior changes, list verification commands, link relevant issues, and include screenshots for visual changes. Note compositor-specific behavior or new system dependencies explicitly.

## Security & Configuration Tips

Treat imported LPK files and model paths as untrusted input. Preserve archive path and size checks, and do not broaden Tauri CSP, asset protocol scopes, or `model://` filesystem access without documenting the security impact.
