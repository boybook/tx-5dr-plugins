import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: import.meta.dirname,
  base: './',
  build: {
    outDir: resolve(import.meta.dirname, '..', 'dist', 'ui'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        'operator-webview': resolve(import.meta.dirname, 'operator-webview.html'),
        'automation-webview': resolve(import.meta.dirname, 'automation-webview.html'),
      },
    },
  },
});
