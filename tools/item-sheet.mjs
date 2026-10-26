/**
 * Contact sheet: every weapon and deployable, drawn with the game's own
 * renderer, tiled into one picture with its name under it.
 *
 *   node tools/item-sheet.mjs            # tmp/item-sheet.png
 *   node tools/item-sheet.mjs --open     # ...and leave the browser up
 *
 * The question this tool exists to answer is "can you tell what that is?".
 * A joke weapon the player cannot identify is not a joke, so the sheet is
 * the acceptance test for the models: cover the captions and name them.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { chromium } from 'playwright';

const SYSTEM_CHROMIUM = [
  process.env.CHROMIUM_PATH,
  '/opt/pw-browsers/chromium',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
].find((p) => p && existsSync(p));

const PORT = 4179;
const PAGE = 'tmp/item-sheet.html';
const OUT = process.env.SHEET_OUT ?? 'tmp/item-sheet.png';
const SHOW_UI = process.argv.includes('--open');
// --only=id,id narrows the sheet to the models being worked on, which is the
// difference between a two-second look and re-reading all twenty-nine.
const ONLY = process.argv.find((a) => a.startsWith('--only='))?.slice(7);
const COLS = process.argv.find((a) => a.startsWith('--cols='))?.slice(7);
const FP = process.argv.includes('--fp');
const KIND = process.argv.includes('--deployables') ? 'deployables' : null;
const FACE = process.argv.find((a) => a.startsWith('--face='))?.slice(7);
const QUERY = [ONLY && 'only=' + ONLY, COLS && 'cols=' + COLS, FP && 'fp=1',
  KIND && 'kind=' + KIND, FACE && 'face=' + FACE].filter(Boolean).join('&');

const PAGE_HTML = `<!doctype html>
<meta charset="utf-8">
<title>item sheet</title>
<style>
  html, body { margin: 0; background: #12161c; }
  canvas { display: block; }
</style>
<script type="module">
import * as THREE from 'three';
import { ViewModel } from '/src/render/ViewModel.js';
import { buildParts } from '/src/render/parts.js';
import { preloadWeaponModels } from '/src/render/WeaponModels.js';

const TILE = 300;
const CAPTION = 40;
const COLS = Number(new URLSearchParams(location.search).get('cols') ?? 6);
// The view that actually matters is the one the player gets: the weapon in
// the corner of their own screen, seen from behind and to the left. A side
// profile flatters a model whose only recognisable feature faces forward.
const FP = new URLSearchParams(location.search).has('fp');

const manifest = await (await fetch('/data/manifest.json')).json();
const only = new URLSearchParams(location.search).get('only');
// Deployables are drawn standing on the floor, which is the only way
// anyone ever sees them, rather than held in a hand.
const KIND = new URLSearchParams(location.search).get('kind') ?? 'weapons';
const folder = KIND === 'deployables' ? 'deployables' : 'weapons';
const ids = only ? only.split(',') : manifest.content[folder];
const weapons = [];
for (const id of ids) weapons.push(await (await fetch('/data/' + folder + '/' + id + '.json')).json());
if (KIND !== 'deployables') {
  await preloadWeaponModels(Object.fromEntries(weapons.map((w) => [w.id, w])), { base: '/' });
}

const TILE_W = FP ? Math.round((TILE * 16) / 9) : TILE;
const rows = Math.ceil(weapons.length / COLS);
const sheet = document.createElement('canvas');
sheet.width = COLS * TILE_W;
sheet.height = rows * (TILE + CAPTION);
document.body.append(sheet);
const ctx = sheet.getContext('2d');
ctx.fillStyle = '#12161c';
ctx.fillRect(0, 0, sheet.width, sheet.height);

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(2);
renderer.setSize(TILE_W, TILE, false);
renderer.setClearColor(0x2a313a, 1);

const cam = new THREE.PerspectiveCamera(38, 1, 0.01, 50);
const vm = new ViewModel();
const target = new THREE.Vector3();
const dir = new THREE.Vector3();
const box = new THREE.Box3();
const sphere = new THREE.Sphere();

// A ground plane and a sky, so a floor-standing prop has something to
// stand on and reads at the angle a player walks up to it from.
const world = new THREE.Scene();
world.add(new THREE.HemisphereLight(0xbcd4f5, 0x3a3426, 2.0));
const worldSun = new THREE.DirectionalLight(0xfff2d8, 1.7);
worldSun.position.set(-3, 5, 2);
world.add(worldSun);
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(20, 20).rotateX(-Math.PI / 2),
  new THREE.MeshLambertMaterial({ color: 0x4a515b }),
);
world.add(ground);
const holder = new THREE.Group();
world.add(holder);

for (let i = 0; i < weapons.length; i++) {
  const w = weapons[i];
  if (KIND === 'deployables') {
    holder.clear();
    const built = buildParts(w.view?.parts ?? [], { body: w.view?.color, accent: w.view?.accent });
    holder.add(built.group);
    box.setFromObject(holder);
    box.getCenter(target);
    const radius = Math.max(0.1, box.getBoundingSphere(sphere).radius);
    const dist = (radius / Math.sin((cam.fov * Math.PI) / 360)) * 1.3;
    // Eye height, a step or two back: how you actually come across one.
    const face = new URLSearchParams(location.search).get('face');
    if (face === 'front') dir.set(0.06, 0.1, -1).normalize().multiplyScalar(dist);
    else dir.set(0.66, 0.40, -0.84).normalize().multiplyScalar(dist);
    cam.position.copy(target).add(dir);
    cam.lookAt(target);
    renderer.render(world, cam);
  } else {
  vm.setWeapon(w);
  // One update settles the model into its hip pose; without it the parts
  // sit at the origin rather than where the weapon says to hold them.
  vm.update(0.016, 0, { x: 0, y: 0 }, true);

  if (FP) {
    // Exactly what the player sees, from the game's own view camera.
    vm.setAspect(TILE_W / TILE);
    renderer.render(vm.scene, vm.camera);
  } else {
    // Frame on what is actually there. A fixed camera flatters a long gun
    // and loses a small gadget off the bottom of the tile, which is the
    // opposite of what a sheet for judging readability should do.
    box.setFromObject(vm.model);
    box.getCenter(target);
    const radius = Math.max(0.06, box.getBoundingSphere(sphere).radius);
    const dist = (radius / Math.sin((cam.fov * Math.PI) / 360)) * 1.12;
    // Near side-on, a touch ahead and above: the view a weapon is
    // recognised from. Dead-on profile hides the muzzle, dead-ahead hides
    // the length.
    dir.set(0.93, 0.30, -0.22).normalize().multiplyScalar(dist);
    cam.position.copy(target).add(dir);
    cam.lookAt(target);
    renderer.render(vm.scene, cam);
  }
  }

  const col = i % COLS;
  const row = Math.floor(i / COLS);
  const x = col * TILE_W;
  const y = row * (TILE + CAPTION);
  ctx.drawImage(renderer.domElement, x, y, TILE_W, TILE);

  ctx.fillStyle = '#e8edf4';
  ctx.font = '600 17px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(w.name, x + TILE_W / 2, y + TILE + 22);
  ctx.fillStyle = '#7b8696';
  ctx.font = '13px system-ui, sans-serif';
  ctx.fillText(w.id, x + TILE_W / 2, y + TILE + 36);
}

window.__sheetReady = true;
</script>
`;

function build() {
  mkdirSync('tmp', { recursive: true });
  writeFileSync(PAGE, PAGE_HTML);
}

function startServer() {
  const proc = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('dev server did not start')), 25000);
    const onData = (buf) => {
      if (buf.toString().includes(String(PORT))) { clearTimeout(timer); resolve(proc); }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', (code) => reject(new Error('vite exited with ' + code)));
  });
}

async function main() {
  build();
  const server = await startServer();
  const browser = await chromium.launch({
    headless: !SHOW_UI,
    ...(SYSTEM_CHROMIUM ? { executablePath: SYSTEM_CHROMIUM } : {}),
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1800, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    const text = m.text();
    if (m.type() === 'error' && !text.includes('favicon')) errors.push(text);
  });

  await page.goto('http://localhost:' + PORT + '/' + PAGE + (QUERY ? '?' + QUERY : ''), { waitUntil: 'load' });
  await page.waitForFunction('window.__sheetReady === true', null, { timeout: 60000 });
  const canvas = await page.$('canvas');
  await canvas.screenshot({ path: OUT });

  if (!SHOW_UI) await browser.close();
  try { process.kill(-server.pid); } catch {}

  if (errors.length) {
    console.error('page errors:\n  ' + errors.join('\n  '));
    process.exitCode = 1;
  }
  console.log('wrote ' + OUT);
}

main().catch((e) => { console.error(e); process.exit(1); });
