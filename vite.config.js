import { defineConfig } from 'vite';

// base: './' keeps every asset URL relative, so the same build works from a
// file server at the root and from a GitHub Pages project subpath.
export default defineConfig({
  base: './',
  server: { port: 5173, open: false },
  build: { target: 'es2022', outDir: 'dist', assetsInlineLimit: 0 },
});
