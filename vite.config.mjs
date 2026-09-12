import { defineConfig } from 'vite';
import { resolve } from 'path';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  root: 'src',
  publicDir: 'lib',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'src/index.html'),
        config: resolve(import.meta.dirname, 'src/config.html'),
      },
    },
  },
  server: {
    host: '127.0.0.1',
    strictPort: true,
  },
});
