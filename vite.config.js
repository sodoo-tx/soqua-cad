import { defineConfig } from 'vite';

// base './' so the built site works from any GitHub Pages sub-path
export default defineConfig({
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
  optimizeDeps: { exclude: ['replicad-opencascadejs'] },
  server: { port: 5173 },
});
