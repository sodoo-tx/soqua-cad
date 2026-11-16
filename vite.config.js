import { defineConfig } from 'vite';

// base './' so the built site works from any GitHub Pages sub-path
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      output: {
        // three.js and the kernel bindings change rarely: keep them in their own files so an app
        // update only re-downloads the small application chunk
        advancedChunks: {
          groups: [
            // core library only: the file importers under three/examples stay lazily loaded
            { name: 'three', test: /node_modules[\\/]three[\\/]build[\\/]/ },
            { name: 'kernel', test: /node_modules[\\/](replicad|replicad-opencascadejs|opentype\.js)[\\/]/ },
          ],
        },
      },
    },
  },
  optimizeDeps: { exclude: ['replicad-opencascadejs'] },
  server: { port: 5173 },
});
