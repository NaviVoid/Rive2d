.PHONY: dev build install check clean distclean fmt clippy

# Run the app in development mode (Vite + Tauri) with a dynamic port
dev:
	@PORT=$$(node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close()})") && \
	echo "[rive2d] dev port: $$PORT" && \
	pnpm tauri dev --config '{"build":{"devUrl":"http://127.0.0.1:'$$PORT'","beforeDevCommand":"vite --port '$$PORT'"}}'

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
