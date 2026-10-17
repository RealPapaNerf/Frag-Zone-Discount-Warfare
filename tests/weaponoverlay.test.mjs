import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BASE, placeActor, nodeReader } from './helpers.mjs';
import { World } from '../src/engine/sim/World.js';
import { loadContent } from '../src/data/Content.js';
import { WeaponOverlay, knownWeaponPaths } from '../src/engine/rules/WeaponOverlay.js';

/**
 * The overlay exists so a patch note can rewrite a weapon for one match
 * without the change leaking into the next one, the lobby, or the workshop.
 * Most of these tests are about that isolation.
 */

const hold = (extra = {}) => ({ forward: 0, strafe: 0, jump: false, fire: false, ...extra });
const run = (world, ticks) => { for (let i = 0; i < ticks; i++) world.step(1 / 60); };

function duel(loadout, gap = 10) {
  const world = new World({ ...BASE, modeId: 'patch_notes' });
  const a = world.addActor({ id: 'a', name: 'A', characterId: 'grunt', loadout });
  const b = world.addActor({ id: 'b', name: 'B', characterId: 'grunt', loadout: ['rifle'] });
  placeActor(world, a, -19, 0, -gap / 2);
  placeActor(world, b, -19, 0, gap / 2);
  a.spawnProtectUntil = -1;
  b.spawnProtectUntil = -1;
  a.setLook(Math.PI, Math.atan2(0.9 - 1.6, gap));
  return { world, a, b };
}

const land = (world, id) => world.applyPatchNote(world.content.notes[id]);

// --- isolation -------------------------------------------------------------

test('patching a weapon never touches the loaded content', () => {
  const before = JSON.stringify(BASE.content.weapons.rocket_launcher);
  const { world } = duel(['rocket_launcher']);
  land(world, 'rockets_full_auto');

  assert.equal(world.weaponById('rocket_launcher').fire.auto, true);
  assert.equal(JSON.stringify(BASE.content.weapons.rocket_launcher), before,
    'the shared document must be untouched');
  assert.equal(BASE.content.weapons.rocket_launcher.fire.auto, false);
});

test('a patch does not follow you into the next match', () => {
  const first = duel(['rocket_launcher']);
  land(first.world, 'rockets_full_auto');
  assert.equal(first.world.weaponById('rocket_launcher').fire.auto, true);

  const second = duel(['rocket_launcher']);
  assert.equal(second.world.weaponById('rocket_launcher').fire.auto, false,
    'a fresh match starts from the unmodified weapon');
});

test('an unpatched weapon is the loaded document itself, not a copy', () => {
  const { world } = duel(['rifle']);
  assert.equal(world.weaponById('rifle'), BASE.content.weapons.rifle,
    'copy-on-write means no copying until something is written');
});

test('patches accumulate on one weapon without losing earlier ones', () => {
  const overlay = new WeaponOverlay(BASE.content.weapons);
  overlay.apply([{ weapon: 'rifle', path: 'fire.rpm', op: 'set', value: 900 }]);
  overlay.apply([{ weapon: 'rifle', path: 'fire.damage', op: 'mul', value: 2 }]);

  const rifle = overlay.get('rifle');
  assert.equal(rifle.fire.rpm, 900, 'the first patch must survive the second');
  assert.equal(rifle.fire.damage, BASE.content.weapons.rifle.fire.damage * 2);
});

test('a patch can build a block the weapon did not have', () => {
  const overlay = new WeaponOverlay(BASE.content.weapons);
  overlay.apply([{ weapon: 'rocket_launcher', path: 'fire.burst.count', op: 'set', value: 3 }]);
  assert.equal(overlay.get('rocket_launcher').fire.burst.count, 3);
  assert.equal(BASE.content.weapons.rocket_launcher.fire.burst, undefined);
});

test('the revision changes so a cache keyed on the id notices', () => {
  const overlay = new WeaponOverlay(BASE.content.weapons);
  const before = overlay.get('rifle').rev ?? 0;
  overlay.apply([{ weapon: 'rifle', path: 'fire.rpm', op: 'set', value: 700 }]);
  assert.ok((overlay.get('rifle').rev ?? 0) > before,
    'the view model rebuilds on this, not on the id');
});

test('patching a weapon that does not exist is an error, not a silent no-op', () => {
  const overlay = new WeaponOverlay(BASE.content.weapons);
  assert.throws(
    () => overlay.apply([{ weapon: 'trebuchet', path: 'fire.rpm', op: 'set', value: 1 }]),
    /unknown weapon "trebuchet"/,
  );
});

test('reset puts the originals back', () => {
  const overlay = new WeaponOverlay(BASE.content.weapons);
  overlay.apply([{ weapon: 'rifle', path: 'fire.rpm', op: 'set', value: 900 }]);
  overlay.reset();
  assert.equal(overlay.get('rifle'), BASE.content.weapons.rifle);
});

// --- the patches actually reach the simulation -----------------------------

test('"Rockets are now fully automatic" makes a held trigger keep firing', () => {
  const { world, a } = duel(['rocket_launcher']);
  const count = () => {
    let n = 0;
    world.events.on('fire', () => { n += 1; });
    return () => n;
  };
  const shots = count();
  world.setCommand('a', hold({ fire: true, yaw: a.yaw, pitch: a.pitch }));
  run(world, 60);
  assert.equal(shots(), 1, 'sanity: semi-automatic before the note');

  land(world, 'rockets_full_auto');
  world.setCommand('a', hold({ fire: false, yaw: a.yaw, pitch: a.pitch }));
  world.step(1 / 60);
  world.setCommand('a', hold({ fire: true, yaw: a.yaw, pitch: a.pitch }));
  run(world, 90);
  assert.ok(shots() > 2, `expected a stream of rockets, got ${shots()} shots total`);
});

test('"Rockets are melee only" turns the launcher into a club', () => {
  // Far apart: a melee rocket launcher should now reach nobody.
  const far = duel(['rocket_launcher'], 14);
  land(far.world, 'rockets_melee_only');
  assert.equal(far.world.weaponById('rocket_launcher').fire.type, 'melee');
  far.world.setCommand('a', hold({ fire: true, yaw: far.a.yaw, pitch: far.a.pitch }));
  run(far.world, 20);
  assert.equal(far.b.health, 100, 'a club does not reach across the room');
  assert.equal(far.world.projectiles.projectiles.length, 0, 'and fires no rockets');

  // Up close it swings.
  const near = duel(['rocket_launcher'], 2.2);
  land(near.world, 'rockets_melee_only');
  near.a.setLook(Math.PI, 0);
  near.world.setCommand('a', hold({ fire: true, yaw: Math.PI, pitch: 0 }));
  run(near.world, 10);
  assert.ok(near.b.health < 100, 'at arm\'s length it should connect');
});

test('"Axes now SLAY" is a one-hit kill where the axe was not', () => {
  const before = duel(['axe'], 8);
  before.a.setLook(Math.PI, Math.atan2(0.9 - 1.6, 8));
  before.world.setCommand('a', hold({ fire: true, yaw: before.a.yaw, pitch: before.a.pitch }));
  run(before.world, 40);
  const normalDamage = 100 - before.b.health;
  assert.ok(normalDamage > 0 && before.b.alive, 'sanity: a plain axe wounds');

  const after = duel(['axe'], 8);
  land(after.world, 'axes_slay');
  after.a.setLook(Math.PI, Math.atan2(0.9 - 1.6, 8));
  after.world.setCommand('a', hold({ fire: true, yaw: after.a.yaw, pitch: after.a.pitch }));
  run(after.world, 40);
  assert.equal(after.b.alive, false, 'a slaying axe should finish the job');
});

test('a mid-match patch clamps a magazine that no longer fits', () => {
  const { world, a } = duel(['rifle']);
  assert.equal(a.mag.rifle, 30);
  world.applyPatchNote({
    id: 'smaller_mags', headline: 'Reduced magazine size', tier: 1,
    weaponPatches: [{ weapon: 'rifle', path: 'ammo.magazine', op: 'set', value: 5 }],
  });
  assert.equal(a.mag.rifle, 5, 'you cannot keep rounds the magazine no longer holds');
});

// --- authoring safety ------------------------------------------------------

test('a weapon patch aimed at a field no weapon has is rejected at load', async () => {
  const bad = {
    schema: 1, id: 'typo_note', name: 'Typo', headline: 'Typo', tier: 3,
    weaponPatches: [{ weapon: 'rifle', path: 'fire.atuo', op: 'set', value: true }],
  };
  await assert.rejects(() => loadContent(async (path) => {
    if (path === 'notes/typo_note.json') return bad;
    if (path === 'manifest.json') {
      const real = await nodeReader('manifest.json');
      return { ...real, content: { ...real.content, notes: ['typo_note'] } };
    }
    return nodeReader(path);
  }), /patches "fire\.atuo", which no weapon has/);
});

test('a weapon patch aimed at a weapon that does not exist is rejected at load', async () => {
  const bad = {
    schema: 1, id: 'ghost_note', name: 'Ghost', headline: 'Ghost', tier: 3,
    weaponPatches: [{ weapon: 'trebuchet', path: 'fire.rpm', op: 'set', value: 1 }],
  };
  await assert.rejects(() => loadContent(async (path) => {
    if (path === 'notes/ghost_note.json') return bad;
    if (path === 'manifest.json') {
      const real = await nodeReader('manifest.json');
      return { ...real, content: { ...real.content, notes: ['ghost_note'] } };
    }
    return nodeReader(path);
  }), /patches unknown weapon "trebuchet"/);
});

test('the legal path set is drawn from the weapons that actually loaded', () => {
  const paths = knownWeaponPaths(BASE.content.weapons);
  // Shared by most weapons.
  assert.ok(paths.has('fire.auto'));
  assert.ok(paths.has('fire.damage'));
  // Only one weapon has these, which is enough to make them legal everywhere —
  // that is what lets a note give a rocket a burst block.
  assert.ok(paths.has('fire.burst.count'), 'from the burst rifle');
  assert.ok(paths.has('fire.arcDeg'), 'from the wrench');
  assert.ok(paths.has('projectile.bounce.restitution'), 'from the grenade launcher');
  assert.ok(!paths.has('fire.atuo'));
});
