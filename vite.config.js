import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Stamp the build so a stale page can be identified at a glance, by us or by
// whoever is reporting the bug.
const gitSha = (() => {
  try { return execSync('git rev-parse --short HEAD').toString().trim(); }
  catch { return 'nogit'; }
})();

// base: './' keeps every asset URL relative, so the same build works from a
// file server at the root and from a GitHub Pages project subpath.
export default defineConfig({
  base: './',
  define: {
    __BUILD_SHA__: JSON.stringify(gitSha),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  server: { port: 5173, open: false },
  build: {
    target: 'es2022',
    outDir: 'dist',
    assetsInlineLimit: 0,
    // Two pages: the game, and the arena editor that builds maps for it.
    // They share the renderer and the engine, which is the point — the editor
    // draws a map with the game's own ArenaView, so what you see is what you
    // play.
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        editor: resolve(__dirname, 'editor.html'),
        weapons: resolve(__dirname, 'weapons.html'),
      },
    },
  },
});
