import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: 'src',
  publicDir: 'lib',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'src/index.html'),
        config: resolve(__dirname, 'src/config.html'),
      },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
  },
});
