/**
 * Pomodoro plugin — pure frontend (no backend needed: a focus timer has no
 * cross-origin or crypto requirements). Build output lands in dist/, packed
 * by the repo-root scripts/pack.mjs.
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    host: true,
    port: 5176,
  },
  preview: {
    host: true,
    port: 4176,
  },
  build: {
    target: 'esnext',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    assetsDir: 'assets',
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name].[ext]',
      },
    },
  },
});
