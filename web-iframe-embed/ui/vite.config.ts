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
        'main-right-webview': resolve(import.meta.dirname, 'main-right-webview.html'),
        'voice-left-top-webview': resolve(import.meta.dirname, 'voice-left-top-webview.html'),
        'voice-right-top-webview': resolve(import.meta.dirname, 'voice-right-top-webview.html'),
      },
    },
  },
});
