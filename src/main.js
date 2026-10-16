import { loadContent, browserReader } from './data/Content.js';
import { Game } from './client/Game.js';
import { Menu } from './client/hud/Menu.js';

const canvas = document.getElementById('game');
const hudRoot = document.getElementById('hud');
const menuRoot = document.getElementById('menu');
const loading = document.getElementById('loading');

async function boot() {
  let content;
  try {
    content = await loadContent(browserReader(import.meta.env.BASE_URL));
  } catch (error) {
    loading.innerHTML = `<div class="boot-error"><h2>Content failed to load</h2><pre>${
      String(error.message ?? error)}</pre></div>`;
    throw error;
  }

  const game = new Game({ canvas, hudRoot, content });
  const menu = new Menu(menuRoot, content);

  menu.onStart = (settings) => { menu.hide(); game.start(settings); };
  menu.onResume = () => { menu.hide(); game.resume(); };
  menu.onQuit = () => { game.stop(); menu.show('lobby'); };
  game.onPauseChange = (paused) => { if (paused) menu.show('paused'); };

  window.addEventListener('keydown', (event) => {
    if (event.code === 'KeyR' && game.running && !game.paused) game.restart();
  });

  loading.hidden = true;
  menu.show('lobby');

  // Handy while building: window.game.host.world is the live simulation.
  window.game = game;
}

boot();
