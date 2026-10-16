import { loadContent, browserReader } from './data/Content.js';
import { Game } from './client/Game.js';
import { Menu } from './client/hud/Menu.js';
import { BootProgress } from './client/BootProgress.js';

const canvas = document.getElementById('game');
const hudRoot = document.getElementById('hud');
const menuRoot = document.getElementById('menu');
const loadingRoot = document.getElementById('loading');

async function boot() {
  // We are alive, so the "code never started" watchdog in index.html is moot.
  clearTimeout(window.__bootWatchdog);

  const progress = new BootProgress(loadingRoot);
  progress.setBuild(__BUILD_SHA__, __BUILD_TIME__);

  // Everything before this line — downloading the bundle, parsing three.js,
  // running the module graph — happened before any code of ours could report
  // on it, so account for it from the navigation start.
  progress.note('Downloading and parsing scripts', performance.now());

  let game;
  let menu;
  try {
    const content = await progress.run('Loading content', (detail) =>
      loadContent(
        browserReader(import.meta.env.BASE_URL),
        (done, total, path) => detail(`${done}/${total} · ${path}`),
      ));

    game = await progress.run('Creating WebGL renderer', () =>
      new Game({ canvas, hudRoot, content }));

    menu = await progress.run('Building lobby', () =>
      new Menu(menuRoot, content));
  } catch (error) {
    progress.fail(error);
    throw error;
  }

  menu.onStart = async (settings) => {
    menu.hide();
    // Match start gets the same treatment: it is where the nav graph is built.
    const matchProgress = new BootProgress(loadingRoot);
    try {
      await game.start(settings, matchProgress);
    } catch (error) {
      matchProgress.fail(error);
      throw error;
    }
    console.info(`[frag-zone] match start\n${matchProgress.summary()}`);
    matchProgress.finish();
  };
  menu.onResume = () => { menu.hide(); game.resume(); };
  menu.onQuit = () => { game.stop(); menu.show('lobby'); };
  game.onPauseChange = (paused) => { if (paused) menu.show('paused'); };

  window.addEventListener('keydown', (event) => {
    if (event.code === 'KeyR' && game.running && !game.paused) game.restart();
  });

  // Readable in the console, and on window.__boot, if start-up felt slow.
  console.info(`[frag-zone] build ${__BUILD_SHA__} (${__BUILD_TIME__})`);
  console.info(`[frag-zone] boot\n${progress.summary()}`);
  progress.finish();
  menu.show('lobby');

  // Handy while building: window.game.host.world is the live simulation.
  window.game = game;
}

boot();
