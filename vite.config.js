import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src',
  publicDir: 'lib',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  server: {
    port: 1420,
    strictPort: true,
  },
});
