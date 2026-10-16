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
  const proc = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
    stdio: ['ignore', 'pipe', 'pipe'],
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
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'commit' });
    // Catch the loading screen mid-flight, which is the whole point of it.
    await page.waitForSelector('.boot-steps', { timeout: 30000 }).catch(() => {});
    await page.screenshot({ path: `${OUT_DIR}/0-loading.png` });

    // The lobby is generated from the manifest, so its presence proves the
    // content pipeline loaded and validated.
    await page.waitForSelector('#m-start', { timeout: 60000 });
    console.log(`lobby interactive ${Date.now() - navStart}ms after navigation`);
    const mutatorCount = await page.locator('#m-mutators input').count();
    console.log(`lobby ready, ${mutatorCount} mutator toggles built from JSON`);
    await page.screenshot({ path: `${OUT_DIR}/1-lobby.png` });

    const bootTimings = await page.evaluate(() => window.__boot);
    console.log('boot:');
    for (const s of bootTimings.steps) console.log(`  ${String(s.ms).padStart(6)}ms  ${s.label}`);
    console.log(`  ${String(bootTimings.total).padStart(6)}ms  TOTAL`);

    const matchStart = Date.now();
    await page.click('#m-start');
    await page.waitForFunction(() => window.game?.snapshot?.actors?.length > 0, { timeout: 30000 });
    console.log(`match start took ${Date.now() - matchStart}ms wall clock`);

    const start = await page.evaluate(() => ({
      tick: window.game.snapshot.tick,
      actors: window.game.snapshot.actors.length,
    }));
    console.log(`match started with ${start.actors} fighters`);

    // Let the bots play each other for a while.
    await sleep(12000);
    await page.screenshot({ path: `${OUT_DIR}/2-match.png` });

    const report = await page.evaluate(() => {
      const snap = window.game.snapshot;
      const world = window.game.host.world;
      return {
        tick: snap.tick,
        time: snap.time,
        kills: world.match.killFeed.length,
        totalScore: snap.actors.reduce((sum, a) => sum + Math.abs(a.score), 0),
        moved: snap.actors.filter((a) => Math.hypot(a.vel.x, a.vel.z) > 0.5).length,
        offMap: snap.actors.filter((a) => a.pos.y < -24).map((a) => a.name),
        stuck: snap.actors.filter((a) => a.alive && !a.grounded && Math.abs(a.vel.y) < 0.01).length,
        drawCalls: window.game.renderer.renderer.info.render.calls,
        triangles: window.game.renderer.renderer.info.render.triangles,
        geometries: window.game.renderer.renderer.info.memory.geometries,
      };
    });

    const simSeconds = report.time - 0;
    console.log(`ran ${report.tick} ticks (${simSeconds.toFixed(1)}s sim), `
      + `${report.kills} kills, ${report.moved} fighters moving`);
    console.log(`render: ${report.drawCalls} draw calls, ${report.triangles} triangles, `
      + `${report.geometries} geometries`);

    if (report.tick < 500) problems.push(`simulation barely advanced (${report.tick} ticks)`);
    if (report.moved === 0) problems.push('nobody moved — bots are not navigating');
    if (report.kills === 0) problems.push('no kills in 12s — bots are not fighting');
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

    report.boot = bootTimings;
    writeFileSync(`${OUT_DIR}/report.json`, JSON.stringify(report, null, 2));
  } finally {
    await browser.close();
    server.kill('SIGTERM');
  }

  if (problems.length) {
    console.error(`\nsmoke test FAILED:\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`\nsmoke test passed — screenshots in ${OUT_DIR}/`);
}

main().catch((err) => { console.error(err); process.exit(1); });
