/**
 * End-to-end smoke test: build, serve, open the page in real Chromium, start
 * a match and watch it actually run. Unit tests prove the simulation; this
 * proves the thing boots, renders and does not throw in a browser.
 *
 *   npm run smoke          # headless
 *   npm run smoke -- --ui  # watch it play
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { chromium } from 'playwright';

// Use a preinstalled Chromium when one is present (CI images often ship one
// whose build number does not match the npm package's expectation).
const SYSTEM_CHROMIUM = [
  process.env.CHROMIUM_PATH,
  '/opt/pw-browsers/chromium',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
].find((p) => p && existsSync(p));

const SHOW_UI = process.argv.includes('--ui');
// Localhost hands over the whole bundle instantly, which hides exactly the
// start-up cost a real player on home wifi feels. --slow emulates a poor
// connection so the loading screen can be seen doing its job.
const SLOW_NET = process.argv.includes('--slow');
const PORT = 4178;
const OUT_DIR = 'tmp/smoke';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Always build first: serving a stale dist/ silently tests old code. */
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
      if (buf.toString().includes(String(PORT))) {
        clearTimeout(timer);
        resolve(proc);
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', (code) => reject(new Error(`preview exited with ${code}`)));
  });
}

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
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on('console', (msg) => {
      if (msg.type() === 'error') problems.push(`console.error: ${msg.text()}`);
    });
    page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));

    if (SLOW_NET) {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: 300,
        downloadThroughput: (700 * 1024) / 8, // ~700 kbps
        uploadThroughput: (300 * 1024) / 8,
      });
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      console.log('emulating a slow connection and a 4x slower CPU');
    }

    const navStart = Date.now();
    // ?library=off: the smoke test is about this build, not about whether
    // someone else's static server answered today. Without it a cold or
    // unreachable library puts its whole timeout in front of every run.
    await page.goto(`http://localhost:${PORT}/?library=off`, { waitUntil: 'commit' });
    // Catch the loading screen mid-flight, which is the whole point of it.
    await page.waitForSelector('.boot-steps', { timeout: 30000 }).catch(() => {});
    await page.screenshot({ path: `${OUT_DIR}/0-loading.png` });

    // The lobby is generated from the manifest, so its presence proves the
    // content pipeline loaded and validated.
    await page.waitForSelector('#m-start', { timeout: 60000 });
    console.log(`lobby interactive ${Date.now() - navStart}ms after navigation`);
    const mutatorCount = await page.locator('#m-mutators input').count();
    const weaponCount = await page.locator('#m-loadout input').count();
    console.log(`lobby ready, ${mutatorCount} mutator toggles and `
      + `${weaponCount} weapons built from JSON`);
    await page.screenshot({ path: `${OUT_DIR}/1-lobby.png` });

    const bootTimings = await page.evaluate(() => window.__boot);
    console.log('boot:');
    for (const s of bootTimings.steps) console.log(`  ${String(s.ms).padStart(6)}ms  ${s.label}`);
    console.log(`  ${String(bootTimings.total).padStart(6)}ms  TOTAL`);

    // Pick the deadliest bots on purpose. This check is here to prove combat
    // *works*, not to measure balance, and bots carrying the all-rounder take
    // their time about a kill — a rifle needs six hits where a rocket needed
    // one. Asserting on `normal` would be asserting on the balance of the day.
    await page.selectOption('#m-skill', 'hard');

    const matchStart = Date.now();
    await page.click('#m-start');
    await page.waitForFunction(() => window.game?.snapshot?.actors?.length > 0, { timeout: 30000 });
    console.log(`match start took ${Date.now() - matchStart}ms wall clock`);

    const start = await page.evaluate(() => ({
      tick: window.game.snapshot.tick,
      actors: window.game.snapshot.actors.length,
    }));
    console.log(`match started with ${start.actors} fighters`);

    // Wait for simulated seconds, not wall-clock ones. Under swiftshader this
    // machine renders somewhere between 8 and 10 seconds of game in 12 seconds
    // of real time, and that ratio swings enough to make any wall-clock
    // assertion about bot behaviour flaky. Waiting on sim time takes the GPU
    // out of the measurement entirely.
    const WATCH_SECONDS = 15;
    await page.waitForFunction(
      (want) => window.game?.snapshot?.time >= want,
      WATCH_SECONDS, { timeout: 120000 },
    );
    await page.screenshot({ path: `${OUT_DIR}/2-match.png` });

    const report = await page.evaluate(() => {
      const snap = window.game.snapshot;
      const world = window.game.host.world;
      return {
        tick: snap.tick,
        time: snap.time,
        kills: world.match.killFeed.length,
        // Health missing from the living, plus a full bar for everyone who has
        // already died. This is the real "are they fighting" signal: it moves
        // on the first hit instead of waiting for a sixth.
        damage: snap.actors.reduce(
          (sum, a) => sum + (a.maxHealth - a.health) + a.deaths * a.maxHealth, 0),
        totalScore: snap.actors.reduce((sum, a) => sum + Math.abs(a.score), 0),
        moved: snap.actors.filter((a) => Math.hypot(a.vel.x, a.vel.z) > 0.5).length,
        offMap: snap.actors.filter((a) => a.pos.y < -24).map((a) => a.name),
        stuck: snap.actors.filter((a) => a.alive && !a.grounded && Math.abs(a.vel.y) < 0.01).length,
        drawCalls: window.game.renderer.renderer.info.render.calls,
        triangles: window.game.renderer.renderer.info.render.triangles,
        geometries: window.game.renderer.renderer.info.memory.geometries,
      };
    });

    const simSeconds = report.time;
    console.log(`ran ${report.tick} ticks (${simSeconds.toFixed(1)}s sim), `
      + `${report.kills} kills, ${report.damage} damage dealt, `
      + `${report.moved} fighters moving`);
    console.log(`render: ${report.drawCalls} draw calls, ${report.triangles} triangles, `
      + `${report.geometries} geometries`);

    // We waited on sim time, so this only catches a loop that died outright
    // rather than a slow one.
    if (report.time < WATCH_SECONDS) problems.push(`simulation stalled at ${report.time.toFixed(1)}s`);
    if (report.moved === 0) problems.push('nobody moved — bots are not navigating');
    if (report.damage === 0) {
      problems.push(`nothing took a scratch in ${WATCH_SECONDS}s — bots are not shooting`);
    }
    if (report.kills === 0) {
      problems.push(`no kills in ${WATCH_SECONDS}s — bots are shooting but never finishing`);
    }
    if (report.offMap.length) problems.push(`fell out of the map: ${report.offMap.join(', ')}`);
    if (report.drawCalls > 60) problems.push(`${report.drawCalls} draw calls is too many for a blockout`);

    // A fixed overview frame, for eyeballing map layout and lighting between
    // changes. Pausing first stops the loop overwriting it before capture.
    await page.evaluate(() => {
      window.game.paused = true;
      window.game.renderer.render(0.016, {
        position: { x: 0, y: 34, z: 46 }, yaw: 0, pitch: -0.62, fov: 70,
      });
    });
    await page.screenshot({ path: `${OUT_DIR}/3-overview.png` });

    // A fighter up close, from the side it faces, for eyeballing the model:
    // posed rather than T-posed, facing forward, feet on the floor.
    const fighters = await page.evaluate(() => {
      const g = window.game;
      const views = g.renderer.actorViews;
      const skinned = [...views.values()].filter((v) => v.skinned).length;
      const actor = g.snapshot.actors.find((a) => a.alive && !views.get(a.id)?.hidden);
      if (!actor) return { skinned, framed: false };
      const r = 3.2;
      const fx = -Math.sin(actor.yaw);
      const fz = -Math.cos(actor.yaw);
      const cam = { x: actor.pos.x + fx * r, y: actor.pos.y + 1.1, z: actor.pos.z + fz * r };
      g.renderer.viewModel.root.visible = false;
      g.renderer.render(0.016, {
        position: cam, yaw: Math.atan2(fx, fz), pitch: Math.atan2(-0.15, r), fov: 50,
      });
      return { skinned, framed: true };
    });
    await page.screenshot({ path: `${OUT_DIR}/4-fighter.png` });
    report.skinnedFighters = fighters.skinned;
    console.log(`${fighters.skinned} of ${start.actors} fighters use the skinned model`);
    if (fighters.skinned === 0) problems.push('no fighter got the skinned model — it fell back to boxes');

    report.boot = bootTimings;
    writeFileSync(`${OUT_DIR}/report.json`, JSON.stringify(report, null, 2));
  } finally {
    await browser.close();
    try { process.kill(-server.pid, 'SIGTERM'); } catch { /* already gone */ }
  }

  if (problems.length) {
    console.error(`\nsmoke test FAILED:\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`\nsmoke test passed — screenshots in ${OUT_DIR}/`);
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
