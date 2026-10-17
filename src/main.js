import { loadContent, browserReader } from './data/Content.js';
import { Game } from './client/Game.js';
import { Menu } from './client/hud/Menu.js';
import { BootProgress } from './client/BootProgress.js';
import { PeerHost } from './client/PeerHost.js';
import { RemoteHost } from './client/RemoteHost.js';

const canvas = document.getElementById('game');
const hudRoot = document.getElementById('hud');
const menuRoot = document.getElementById('menu');
const loadingRoot = document.getElementById('loading');

/**
 * Collect a map the editor left in sessionStorage. Taken rather than read:
 * a reload should not silently keep playtesting a map you have since changed.
 */
function takePlaytestMap() {
  if (!new URLSearchParams(location.search).has('playtest')) return null;
  try {
    const raw = sessionStorage.getItem('fragzone.playtest.map');
    sessionStorage.removeItem('fragzone.playtest.map');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** Weapons the workshop left for us, taken the same way as a playtest map. */
function takePlaytestWeapons() {
  if (!new URLSearchParams(location.search).has('playtest')) return [];
  try {
    const raw = sessionStorage.getItem('fragzone.playtest.weapons');
    sessionStorage.removeItem('fragzone.playtest.weapons');
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

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
  // Declared out here because hosting and joining, below, need it long after
  // this try block has ended.
  let content;
  try {
    content = await progress.run('Loading content', (detail) =>
      loadContent(
        browserReader(import.meta.env.BASE_URL),
        (done, total, path) => detail(`${done}/${total} · ${path}`),
      ));

    // A map handed over by the editor's Playtest button. It is injected into
    // the loaded content as if it had always been there, so everything
    // downstream — the lobby's arena list, the loader, the host — treats it
    // like any other map and the editor needs no special path in the game.
    const playtest = takePlaytestMap();
    if (playtest) {
      content.maps[playtest.id] = playtest;
      content.manifest.defaults.map = playtest.id;
      console.info(`[frag-zone] playtesting "${playtest.name}" from the editor`);
    }

    // Weapons from the workshop arrive the same way, and go straight into the
    // default loadout — you pressed "Try it" to try it, not to pick it again.
    const tryWeapons = takePlaytestWeapons();
    if (tryWeapons.length) {
      for (const w of tryWeapons) content.weapons[w.id] = w;
      content.manifest.defaults.loadout = [
        ...tryWeapons.map((w) => w.id),
        ...content.manifest.defaults.loadout,
      ].slice(0, 3);
      console.info(`[frag-zone] trying ${tryWeapons.map((w) => w.name).join(', ')}`);
    }

    game = await progress.run('Creating WebGL renderer', () =>
      new Game({ canvas, hudRoot, content }));

    menu = await progress.run('Building lobby', () =>
      new Menu(menuRoot, content));

    const notes = [];
    if (playtest) notes.push(`arena <b>${playtest.name}</b>`);
    if (tryWeapons.length) notes.push(`weapon${tryWeapons.length > 1 ? 's' : ''} <b>${tryWeapons.map((w) => w.name).join(', ')}</b>`);
    if (notes.length) menu.setNote?.(`Trying ${notes.join(' and ')} — changes are not saved from here.`);
  } catch (error) {
    progress.fail(error);
    throw error;
  }

  // Whatever room we are in, so quitting can leave it.
  let session = null;
  const leaveRoom = () => { session?.close(); session = null; };

  menu.onStart = async (settings) => {
    let host = null;

    // Hosting and joining both have to make the connection before there is a
    // match to start, and both can fail in ways the player needs told about
    // while still sitting in the lobby — so they happen here, not behind the
    // loading screen.
    if (settings.net !== 'solo') {
      const { normaliseRoom, hostRoom, joinHostedRoom } = await import('./net/rooms.js');
      const room = normaliseRoom(settings.room);
      if (!room) {
        menu.setNetStatus('Type a room name first — both of you need to type the same one.', 'bad');
        return;
      }

      try {
        if (settings.net === 'host') {
          menu.setNetStatus(`Opening "${room}"…`);
          host = new PeerHost({ content, ...settings, playerName: 'You' });
          session = hostRoom(room, host, {
            onRoster: (roster) => menu.setNetStatus(
              roster.length > 1
                ? `In "${room}": ${roster.map((r) => r.name).join(', ')}`
                : `Hosting "${room}" — waiting for someone to join.`,
              'good',
            ),
          });
          menu.setNetStatus(`Hosting "${room}" — tell them to Join with that name.`, 'good');
        } else {
          menu.setNetStatus(`Looking for "${room}"…`);
          session = await joinHostedRoom(room);
          const remote = new RemoteHost({ content, transport: session.transport, playerName: 'Guest' });
          await remote.join();
          host = remote;
          menu.setNetStatus(`Joined "${room}".`, 'good');
        }
      } catch (error) {
        leaveRoom();
        menu.setNetStatus(error.message, 'bad');
        return;
      }
    }

    menu.hide();
    // Match start gets the same treatment: it is where the nav graph is built.
    const matchProgress = new BootProgress(loadingRoot);
    try {
      await game.start(settings, matchProgress, host);
    } catch (error) {
      leaveRoom();
      matchProgress.fail(error);
      throw error;
    }
    console.info(`[frag-zone] match start\n${matchProgress.summary()}`);
    matchProgress.finish();
  };
  menu.onResume = () => { menu.hide(); game.resume(); };
  menu.onQuit = () => { game.stop(); leaveRoom(); menu.setNetStatus(''); menu.show('lobby'); };
  game.onPauseChange = (paused) => { if (paused) menu.show('paused'); };

  window.addEventListener('keydown', (event) => {
    // R reloads during a match and only restarts once one is over, because
    // reload is the binding every other shooter has trained into your hands.
    if (event.code !== 'KeyR' || !game.running || game.paused) return;
    if (game.snapshot?.match?.state === 'over') game.restart();
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
