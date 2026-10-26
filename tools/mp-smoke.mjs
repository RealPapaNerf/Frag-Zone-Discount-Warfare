/**
 * Multiplayer smoke test: build, serve, open TWO real Chromium pages, host a
 * room in one and join it from the other — over the real Nostr relays, the
 * same path two brothers on home wifi use. Unit tests prove the protocol on a
 * loopback transport; this proves discovery and WebRTC actually pair up today.
 *
 *   npm run smoke:mp           # headless
 *   npm run smoke:mp -- --ui   # watch both windows
 *
 * What it cannot prove: NAT traversal between two different networks. Both
 * pages are on this machine, so they pair on host candidates. If this passes
 * and two real players still cannot meet, the relays and the game are fine
 * and the blocker is one player's NAT (the TURN setting) or a typo in the
 * room name.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { chromium } from 'playwright';

const SYSTEM_CHROMIUM = [
  process.env.CHROMIUM_PATH,
  '/opt/pw-browsers/chromium',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
].find((p) => p && existsSync(p));

const SHOW_UI = process.argv.includes('--ui');
const PORT = 4179;
const OUT_DIR = 'tmp/smoke';
const ROOM = `bench-${Math.random().toString(36).slice(2, 8)}`;

function build() {
  return new Promise((resolve, reject) => {
    const proc = spawn('npx', ['vite', 'build', '--logLevel', 'warn'], { stdio: 'inherit' });
    proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`build failed (${code})`))));
  });
}

function startServer() {
  // Its own process group, so stopping it can take out the whole npx → sh →
  // vite chain. Killing just the wrapper leaves a vite child holding our
  // stdio pipes open, and node will not exit while they are.
  const proc = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('preview server did not start')), 25000);
    const onData = (buf) => {
      if (buf.toString().includes(String(PORT))) { clearTimeout(timer); resolve(proc); }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', (code) => reject(new Error(`preview exited with ${code}`)));
  });
}

// A real, decodable 1x1 PNG: the face pipeline ends in an <img> that must
// fire onload, so the test face has to be an actual image, not a dummy string.
const TEST_FACE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** Boot a page to the lobby. Each page gets its own context: separate storage. */
async function openLobby(browser, name, problems, { identity = null, query = '' } = {}) {
  const context = await browser.newContext({ viewport: { width: 1100, height: 650 } });
  if (identity) {
    await context.addInitScript((id) => {
      localStorage.setItem('fragzone.identity', JSON.stringify(id));
    }, identity);
  }
  const page = await context.newPage();
  page.on('console', (msg) => {
    const text = msg.text();
    // Trystero announces on several public relays; one of them being down is
    // weather, not a failure — discovery only needs the survivors.
    if (msg.type() === 'error' && text.includes('WebSocket connection')) {
      console.log(`  ${name}: (relay noise) ${text.split(' failed')[0]} failed`);
      return;
    }
    if (msg.type() === 'error') problems.push(`${name} console.error: ${text}`);
    if (text.includes('[frag-zone]')) console.log(`  ${name}: ${text}`);
  });
  page.on('pageerror', (err) => problems.push(`${name} pageerror: ${err.message}`));
  await page.goto(`http://localhost:${PORT}/?library=off${query}`, { waitUntil: 'commit' });
  // The title screen plays once before the lobby; dismiss it immediately.
  await page.waitForSelector('#splash', { state: 'visible', timeout: 3000 }).catch(() => {});
  await page.click('#splash').catch(() => {});
  await page.waitForSelector('#m-start', { timeout: 60000 });
  return page;
}

const netStatus = (page) => page.evaluate(() => document.querySelector('#m-net-status')?.textContent ?? '');

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  await build();
  const server = await startServer();
  const problems = [];

  const browser = await chromium.launch({
    headless: !SHOW_UI,
    ...(SYSTEM_CHROMIUM ? { executablePath: SYSTEM_CHROMIUM } : {}),
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--disable-gpu-sandbox',
    ],
  });

  try {
    console.log(`room "${ROOM}"`);
    // The host has a name and a face picture; the guest arrives through the
    // host's invite link, which should preselect Join and the room for them.
    const [host, guest] = await Promise.all([
      openLobby(browser, 'host', problems, {
        identity: { name: 'Smokey', face: TEST_FACE },
      }),
      openLobby(browser, 'guest', problems, {
        identity: { name: 'Bucket', face: null },
        query: `&join=${ROOM}`,
      }),
    ]);
    console.log('both lobbies interactive');

    const preset = await guest.evaluate(() => ({
      room: document.querySelector('#m-room').value,
      label: document.querySelector('#m-start').textContent,
    }));
    if (preset.room !== ROOM) problems.push(`invite link did not fill the room (got "${preset.room}")`);
    if (!preset.label.includes('JOIN')) problems.push(`invite link did not preselect Join (button says "${preset.label}")`);

    // No bots: this test is about the wire, and an empty arena makes
    // "2 actors" an unambiguous assertion.
    for (const page of [host, guest]) {
      await page.evaluate(() => {
        const slider = document.querySelector('#m-botcount');
        slider.value = '0';
        slider.dispatchEvent(new Event('input'));
      });
    }

    // Host presses Host and starts; their match begins immediately.
    const tHost = Date.now();
    await host.click('#m-mode-seg button[data-net="host"]');
    await host.fill('#m-room', ROOM);
    await host.click('#m-start');
    await host.waitForFunction(() => window.game?.running === true, { timeout: 45000 });
    console.log(`host in the match ${Date.now() - tHost}ms after pressing Host`);

    // The invite link already set Join and the room; the guest just presses
    // the button. This is the leg that exercises Nostr discovery and the
    // WebRTC handshake end to end.
    const tJoin = Date.now();
    await guest.click('#m-start');

    try {
      await guest.waitForFunction(() => window.game?.running === true, { timeout: 45000 });
    } catch {
      problems.push(`guest never entered the match; lobby says: "${await netStatus(guest)}"`);
      throw new Error('join failed');
    }
    console.log(`guest joined ${Date.now() - tJoin}ms after pressing Join`);

    // Let a few snapshot intervals pass, then look at both ends.
    await guest.waitForFunction(
      () => window.game?.snapshot?.actors?.length >= 2, { timeout: 15000 },
    );
    const hostView = await host.evaluate(() => ({
      actors: window.game.snapshot.actors.map((a) => a.name),
      peers: window.game.host.peers ? window.game.host.peers.size : -1,
    }));
    const guestView = await guest.evaluate(() => ({
      actors: window.game.snapshot.actors.map((a) => a.name),
      localId: window.game.host.localActorId,
      connected: window.game.host.connected,
    }));
    console.log(`host sees [${hostView.actors.join(', ')}], ${hostView.peers} peer(s)`);
    console.log(`guest is "${guestView.localId}", sees [${guestView.actors.join(', ')}]`);

    if (hostView.peers !== 1) problems.push(`host has ${hostView.peers} peers, wanted 1`);
    if (!guestView.connected) problems.push('guest host object reports not connected');
    if (guestView.actors.length < 2) problems.push('guest snapshot is missing actors');

    // Names typed in the lobby, not the old hardcoded You/Guest.
    for (const [who, view] of [['host', hostView], ['guest', guestView]]) {
      for (const wanted of ['Smokey', 'Bucket']) {
        if (!view.actors.includes(wanted)) problems.push(`${who} does not see "${wanted}" on the roster`);
      }
    }

    // The host's face picture should have crossed the wire and landed on the
    // host's fighter as the guest draws it.
    try {
      await guest.waitForFunction(
        () => window.game.renderer.actorViews.get('player')?.face?.hasPhoto === true,
        { timeout: 10000 },
      );
      console.log("host's face picture is on their fighter on the guest's screen");
    } catch {
      const faces = await guest.evaluate(() => Object.keys(window.game.host.faces ?? {}));
      problems.push(`host's face never reached the guest's renderer (faces known: [${faces.join(', ')}])`);
    }

    // The guest should see the host MOVE — snapshots flowing, not just one
    // welcome. Walk the host forward and watch their position change on the
    // guest's screen.
    const before = await guest.evaluate(() =>
      window.game.snapshot.actors.find((a) => a.id === 'player')?.pos);
    await host.evaluate(() => {
      const canvas = document.getElementById('game');
      canvas.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true }));
    });
    await host.waitForTimeout(1500);
    const after = await guest.evaluate(() =>
      window.game.snapshot.actors.find((a) => a.id === 'player')?.pos);
    const movedBy = before && after
      ? Math.hypot(after.x - before.x, after.z - before.z) : 0;
    console.log(`host moved ${movedBy.toFixed(2)}m on the guest's screen`);
    if (movedBy < 0.2) problems.push('host movement never reached the guest — snapshots not flowing');

    await host.screenshot({ path: `${OUT_DIR}/mp-host.png` });
    await guest.screenshot({ path: `${OUT_DIR}/mp-guest.png` });
  } catch (error) {
    if (!problems.length) problems.push(error.message);
  } finally {
    await browser.close();
    try { process.kill(-server.pid, 'SIGTERM'); } catch { /* already gone */ }
  }

  if (problems.length) {
    console.error('\nMULTIPLAYER SMOKE FAILED:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log('\nmultiplayer smoke passed: hosted, discovered, joined, snapshots flowing');
  process.exit(0);
}

main().catch((error) => { console.error(error); process.exit(1); });
