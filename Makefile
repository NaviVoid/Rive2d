.PHONY: dev build install check clean distclean fmt clippy

# Run the app in development mode (Vite + Tauri)
dev:
	pnpm tauri dev

# Build the release binary
build:
	pnpm tauri build

# Install all dependencies (pnpm + cargo)
install:
	pnpm install
	cd src-tauri && cargo fetch

# Type-check Rust code without building
check:
	cd src-tauri && cargo check

# Format Rust code
fmt:
	cd src-tauri && cargo fmt

# Run clippy lints
clippy:
	cd src-tauri && cargo clippy

# Remove build artifacts
clean:
	rm -rf dist
	cd src-tauri && cargo clean

# Remove everything (build artifacts + node_modules)
distclean: clean
	rm -rf node_modules
