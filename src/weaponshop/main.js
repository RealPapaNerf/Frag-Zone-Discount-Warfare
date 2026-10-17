import * as THREE from 'three';
import { ViewModel } from '../render/ViewModel.js';
import { statsFor, critique } from './stats.js';
import { ARCHETYPES, generateWeapon, generateSet } from './generate.js';

/**
 * The weapon workshop.
 *
 * Weapons are JSON, the same as maps, so this is the same idea as the arena
 * editor: edit the real document, preview it with the game's own code. The
 * preview is literally `ViewModel` — the class that draws the gun in your
 * hands during a match — so the recoil, the muzzle flash and the shape are
 * not an approximation of the game, they are the game.
 *
 * The numbers panel exists because a weapon is a dozen values that mean
 * nothing individually. You balance against time-to-kill, not damage.
 */

const STORE = 'fragzone.weapons';
const PLAYTEST = 'fragzone.playtest.weapons';
const $ = (s) => document.querySelector(s);

let weapons = load();
let index = 0;

if (!weapons.length) {
  weapons = [generateWeapon('rifle'), generateWeapon('shotgun'), generateWeapon('launcher')];
  save();
}

// --- preview ----------------------------------------------------------------

const canvas = $('#view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const backdrop = new THREE.Scene();
backdrop.background = new THREE.Color('#1b232d');

/**
 * A camera for looking at a weapon, not for holding one.
 *
 * ViewModel's own camera frames the gun as the corner of a full-screen first
 * person view, which in a preview panel puts an enormous barrel across half
 * the picture. The model, the recoil and the muzzle flash are still the
 * game's — only the vantage point is the workshop's.
 */
const previewCam = new THREE.PerspectiveCamera(38, 1, 0.01, 50);
const TARGET = new THREE.Vector3(0.26, -0.22, -0.46);
let orbit = 0;

{
  // A small room, scaled to a thing half a metre long.
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(12, 12).rotateX(-Math.PI / 2),
    new THREE.MeshLambertMaterial({ color: 0x58606c }),
  );
  floor.position.y = -1.1;
  backdrop.add(floor);
  const wall = new THREE.Mesh(
    new THREE.PlaneGeometry(12, 7),
    new THREE.MeshLambertMaterial({ color: 0x424a55 }),
  );
  wall.position.set(0, 2.4, -3.2);
  backdrop.add(wall);
  backdrop.add(new THREE.HemisphereLight(0xbcd4f5, 0x3a3426, 2.1));
  const sun = new THREE.DirectionalLight(0xfff2d8, 1.9);
  sun.position.set(-3, 5, 3);
  backdrop.add(sun);
}

const viewModel = new ViewModel();
let autoFire = 0;

canvas.addEventListener('pointerdown', () => { autoFire = 1; });
addEventListener('pointerup', () => { autoFire = 0; });

function resize() {
  const w = canvas.clientWidth || 1;
  const h = canvas.clientHeight || 1;
  renderer.setSize(w, h, false);
  previewCam.aspect = w / h;
  previewCam.updateProjectionMatrix();
}
addEventListener('resize', resize);

let last = performance.now();
let fireCooldown = 0;
(function loop(now = performance.now()) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  const w = weapons[index];
  if (w) {
    fireCooldown -= dt;
    if (autoFire && fireCooldown <= 0) {
      viewModel.onFire();
      fireCooldown = 60 / Math.max(1, w.fire?.rpm ?? 600);
      if (!w.fire?.auto) autoFire = 0;
    }
  }
  viewModel.setAim?.(false, dt);
  viewModel.update(dt, 0, { x: 0, y: 0 }, true);

  // A slow drift around the weapon, so its shape reads without a control to
  // learn. Click still fires, which is the only interaction worth having.
  orbit += dt * 0.25;
  const swing = Math.sin(orbit) * 0.55;
  previewCam.position.set(
    TARGET.x + Math.sin(swing) * 1.25,
    TARGET.y + 0.26,
    TARGET.z + Math.cos(swing) * 1.25,
  );
  previewCam.lookAt(TARGET);

  renderer.autoClear = true;
  renderer.render(backdrop, previewCam);
  renderer.autoClear = false;
  renderer.clearDepth();
  renderer.render(viewModel.scene, previewCam);
  requestAnimationFrame(loop);
})();

// --- panels -----------------------------------------------------------------

$('#archetype').innerHTML = Object.entries(ARCHETYPES)
  .map(([k, a]) => `<option value="${k}">${a.label}</option>`).join('');

function renderList() {
  $('#list').innerHTML = weapons.map((w, i) =>
    `<button data-i="${i}" class="${i === index ? 'on' : ''}">${esc(w.name)}
       <small>${w.fire.type} · ${w.fire.rpm} rpm · ${w.fire.damage} dmg${w.fire.pellets > 1 ? ` ×${w.fire.pellets}` : ''}</small>
     </button>`).join('');
  for (const b of document.querySelectorAll('#list button')) {
    b.onclick = () => { index = Number(b.dataset.i); selectWeapon(); };
  }
}

function num(label, value, onChange, step = 1, path = '') {
  const id = `n${Math.random().toString(36).slice(2, 8)}`;
  setTimeout(() => {
    const el = document.getElementById(id);
    if (el) el.onchange = () => onChange(Number(el.value));
  });
  return `<div class="field"><span title="${path}">${label}</span><input id="${id}" type="number" step="${step}" value="${value ?? 0}"></div>`;
}

function text(label, value, onChange) {
  const id = `t${Math.random().toString(36).slice(2, 8)}`;
  setTimeout(() => {
    const el = document.getElementById(id);
    if (el) el.onchange = () => onChange(el.value);
  });
  return `<div class="field"><span>${label}</span><input id="${id}" type="text" value="${esc(value ?? '')}"></div>`;
}

function colorRow(label, value, onChange) {
  const id = `c${Math.random().toString(36).slice(2, 8)}`;
  setTimeout(() => {
    const el = document.getElementById(id);
    if (el) el.oninput = () => onChange(el.value);
  });
  return `<div class="field"><span>${label}</span><input id="${id}" type="color" value="${value ?? '#888888'}"></div>`;
}

function renderFire() {
  const w = weapons[index];
  const f = w.fire;
  let html = text('name', w.name, (v) => {
    w.name = v;
    w.id = v.toLowerCase().replace(/[^a-z0-9]+/g, '_') || 'weapon';
    touch();
  });
  html += `<div class="field"><span>type</span><select id="w-type">
      <option${f.type === 'hitscan' ? ' selected' : ''}>hitscan</option>
      <option${f.type === 'projectile' ? ' selected' : ''}>projectile</option>
    </select></div>`;
  html += `<div class="field"><span>auto</span><input type="checkbox" id="w-auto"${f.auto ? ' checked' : ''}></div>`;
  html += num('rpm', f.rpm, (v) => { f.rpm = v; touch(); }, 10);
  html += num('damage', f.damage, (v) => { f.damage = v; touch(); }, 1);
  html += num('pellets', f.pellets ?? 1, (v) => { f.pellets = Math.max(1, v); touch(); }, 1);
  html += num('head ×', f.headshotMultiplier ?? 1, (v) => { f.headshotMultiplier = v; touch(); }, 0.1);
  html += num('spread°', f.spreadDeg ?? 0, (v) => { f.spreadDeg = v; touch(); }, 0.1);
  html += num('ads°', f.spreadDegAds ?? 0, (v) => { f.spreadDegAds = v; touch(); }, 0.05);
  html += num('moving°', f.spreadDegMoving ?? 0, (v) => { f.spreadDegMoving = v; touch(); }, 0.1);
  html += num('range', f.range ?? 100, (v) => { f.range = v; touch(); }, 10);
  html += num('knockback', f.knockback ?? 0, (v) => { f.knockback = v; touch(); }, 0.2);
  html += num('ammo', w.ammo?.start ?? 0, (v) => { (w.ammo ??= {}).start = v; touch(); }, 10);
  if (w.splash) {
    html += num('splash r', w.splash.radius, (v) => { w.splash.radius = v; touch(); }, 0.2);
    html += num('splash dmg', w.splash.damage, (v) => { w.splash.damage = v; touch(); }, 1);
    html += num('self dmg', w.splash.selfDamageScale, (v) => { w.splash.selfDamageScale = v; touch(); }, 0.05);
  }
  if (w.projectile) {
    html += num('proj speed', w.projectile.speed, (v) => { w.projectile.speed = v; touch(); }, 2);
    html += num('proj gravity', w.projectile.gravityScale ?? 0, (v) => { w.projectile.gravityScale = v; touch(); }, 0.05);
  }
  $('#fire').innerHTML = html;
  $('#w-type').onchange = (e) => {
    f.type = e.target.value;
    if (f.type === 'projectile' && !w.projectile) {
      w.projectile = { speed: 42, radius: 0.22, gravityScale: 0, lifetime: 6, spawnOffset: [0.18, -0.12, -0.6], color: w.view.accent, trail: w.view.color };
      w.splash = { radius: 5, damage: f.damage, minDamage: 12, knockback: 16, minKnockback: 4, selfDamageScale: 0.45, selfKnockbackScale: 1, upBias: 0.35 };
    }
    touch(true);
  };
  $('#w-auto').onchange = (e) => { f.auto = e.target.checked; touch(); };
}

function renderLook() {
  const w = weapons[index];
  const v = (w.view ??= {});
  let html = `<div class="field"><span>shape</span><select id="w-shape">
      <option value="rifle"${v.shape !== 'launcher' ? ' selected' : ''}>rifle</option>
      <option value="launcher"${v.shape === 'launcher' ? ' selected' : ''}>launcher</option>
    </select></div>`;
  html += colorRow('body', v.color ?? '#9aa6b2', (c) => { v.color = c; touch(true); });
  html += colorRow('accent', v.accent ?? '#36e0ff', (c) => { v.accent = c; touch(true); });
  html += num('kick', v.kick ?? 0.04, (n) => { v.kick = n; touch(true); }, 0.01);
  $('#look').innerHTML = html;
  $('#w-shape').onchange = (e) => { v.shape = e.target.value; touch(true); };
}

function renderStats() {
  const w = weapons[index];
  const s = statsFor(w);
  // A one-shot kill takes no time *between* shots, which "0 ms" states
  // accurately and communicates badly.
  const t = (v) => (!Number.isFinite(v) ? '—' : v === 0 ? 'one shot' : `${(v * 1000) | 0} ms`);
  $('#stats').innerHTML = `
    <b>damage / shot</b><span>${round(s.perShot)}</span>
    <b>DPS</b><span>${round(s.dps)}</span>
    <b>shots to kill</b><span>${Number.isFinite(s.stk) ? s.stk : '—'}</span>
    <b>time to kill</b><span>${t(s.ttk)}</span>
    <b>headshot TTK</b><span>${t(s.headTtk)}</span>
    <b>ammo lasts</b><span>${s.sustainSec.toFixed(1)} s</span>
    <b>spread @ 20 m</b><span>${round(s.coneAt(20))} m</span>
    <b>ads @ 20 m</b><span>${round(s.adsConeAt(20))} m</span>
    <b>damage @ 50 m</b><span>${round(s.damageAt(50))}</span>
  `;
  if (s.allPelletsAssumed) {
    $('#stats').insertAdjacentHTML('beforeend',
      `<b class="warn">assumes</b><span class="warn">all ${s.pellets} pellets hit</span>`);
  }
  const notes = critique(w);
  $('#notes').innerHTML = notes.length
    ? notes.map(([k, m]) => `<p class="${k === 'bad' ? 'bad' : 'warn'}">${m}</p>`).join('')
    : '<p class="muted">Nothing obviously broken.</p>';
}

function selectWeapon(rebuildModel = true) {
  if (rebuildModel) { viewModel.weaponId = null; viewModel.setWeapon(weapons[index]); }
  renderList(); renderFire(); renderLook(); renderStats();
}

/** A value changed: re-derive everything that depends on it. */
function touch(rebuildModel = false) {
  save();
  if (rebuildModel) { viewModel.weaponId = null; viewModel.setWeapon(weapons[index]); }
  renderList(); renderStats();
}

// --- actions ----------------------------------------------------------------

$('#b-new').onclick = () => {
  weapons.push(generateWeapon($('#archetype').value));
  index = weapons.length - 1;
  save(); selectWeapon();
};
$('#b-generate').onclick = () => {
  weapons[index] = generateWeapon($('#archetype').value);
  save(); selectWeapon();
  toast(`Rolled ${weapons[index].name}`);
};
$('#b-generate-set').onclick = () => {
  const set = generateSet(1);
  weapons.push(...set);
  index = weapons.length - set.length;
  save(); selectWeapon();
  toast(`Generated ${set.length} weapons, one of each archetype`);
};

$('#b-open').onclick = () => $('#b-file').click();
$('#b-file').onchange = async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    const list = Array.isArray(parsed) ? parsed : [parsed];
    weapons.push(...list);
    index = weapons.length - 1;
    save(); selectWeapon();
    toast(`Loaded ${list.length} weapon(s)`);
  } catch (err) { toast(`Could not read that: ${err.message}`, true); }
  e.target.value = '';
};

const download = (name, body) => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([body], { type: 'application/json' }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
};

$('#b-save').onclick = () => {
  const w = weapons[index];
  download(`${w.id}.json`, JSON.stringify(w, null, 2) + '\n');
  toast(`Saved ${w.id}.json — drop it in public/data/weapons/ and add "${w.id}" to the manifest`);
};
$('#b-save-all').onclick = () => {
  download('weapons.json', JSON.stringify(weapons, null, 2) + '\n');
  toast(`Saved all ${weapons.length}`);
};
$('#b-copy').onclick = async () => {
  try { await navigator.clipboard.writeText(JSON.stringify(weapons[index], null, 2)); toast('Copied'); }
  catch { toast('Clipboard refused; use Save JSON', true); }
};

$('#b-play').onclick = () => {
  const bad = critique(weapons[index]).filter(([k]) => k === 'bad');
  if (bad.length) { toast(`Fix this first: ${bad[0][1]}`, true); return; }
  sessionStorage.setItem(PLAYTEST, JSON.stringify([weapons[index]]));
  location.href = './index.html?playtest=1';
};

// --- plumbing ---------------------------------------------------------------

function save() {
  try { localStorage.setItem(STORE, JSON.stringify(weapons)); } catch { /* private mode */ }
}
function load() {
  try { return JSON.parse(localStorage.getItem(STORE) ?? '[]'); } catch { return []; }
}

let toastTimer = null;
function toast(message, bad = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('bad', bad);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

const esc = (s) => String(s).replace(/"/g, '&quot;').replace(/</g, '&lt;');
const round = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : '—');

resize();
selectWeapon();
