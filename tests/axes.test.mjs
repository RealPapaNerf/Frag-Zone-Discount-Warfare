import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BASE, placeActor } from './helpers.mjs';
import { World } from '../src/engine/sim/World.js';

/**
 * Two Tier 3 notes that needed mechanics rather than numbers: a weapon that
 * pulls its own trigger, and a projectile that will not fly straight.
 */

const hold = (extra = {}) => ({ forward: 0, strafe: 0, jump: false, fire: false, ...extra });
const run = (world, ticks) => { for (let i = 0; i < ticks; i++) world.step(1 / 60); };

function thrower(loadout = ['axe'], note = null) {
  const world = new World({ ...BASE, modeId: 'patch_notes', seed: 9 });
  const a = world.addActor({ id: 'a', name: 'A', characterId: 'grunt', loadout });
  placeActor(world, a, -19, 0, 0);
  a.spawnProtectUntil = -1;
  a.setLook(Math.PI, 0);
  if (note) world.applyPatchNote(world.content.notes[note]);
  // Standing still, doing nothing.
  world.setCommand('a', hold({ yaw: Math.PI, pitch: 0 }));
  return { world, a };
}

// --- axes launch themselves ------------------------------------------------

test('a self-firing weapon goes off with no input at all', () => {
  const { world, a } = thrower(['axe'], 'axes_auto_launch');
  const every = world.weaponById('axe').fire.autoFireEverySec;
  const at = [];
  world.events.on('autoFire', () => at.push(world.time));

  run(world, 60 * 10);
  assert.ok(at.length >= 3, `expected a few self-launches, got ${at.length}`);
  assert.ok(Math.abs(at[0] - every) < 0.1, `first at ${at[0]}, wanted ${every}`);
  assert.ok(Math.abs((at[1] - at[0]) - every) < 0.1, 'and then on the interval');
  assert.ok(a.ammo.axe < world.content.weapons.axe.ammo.start, 'it spends real axes');
});

test('a weapon that does not ask to fire itself never does', () => {
  const { world } = thrower(['axe']); // no note
  let fired = 0;
  world.events.on('autoFire', () => { fired += 1; });
  run(world, 60 * 10);
  assert.equal(fired, 0);
});

test('self-firing does not take manual firing away from you', () => {
  const { world, a } = thrower(['axe'], 'axes_auto_launch');
  let shots = 0;
  world.events.on('fire', () => { shots += 1; });

  world.setCommand('a', hold({ fire: true, yaw: Math.PI, pitch: 0 }));
  run(world, 30);
  assert.ok(shots >= 1, 'the trigger should still work');
});

test('a self-firing weapon does not bank up shots it could not take', () => {
  const { world, a } = thrower(['axe'], 'axes_auto_launch');
  a.ammo.axe = 0; // nothing to throw for a while
  let fired = 0;
  world.events.on('autoFire', () => { fired += 1; });
  run(world, 60 * 10);
  assert.equal(fired, 0, 'an empty weapon fires nothing');

  a.ammo.axe = 12;
  run(world, 60 * 4);
  assert.ok(fired >= 1 && fired <= 2,
    `it should resume on the clock, not release a volley — got ${fired}`);
});

test('putting the weapon away resets its timer', () => {
  const world = new World({ ...BASE, modeId: 'patch_notes', seed: 9 });
  const a = world.addActor({
    id: 'a', name: 'A', characterId: 'grunt', loadout: ['axe', 'rifle'],
  });
  placeActor(world, a, -19, 0, 0);
  a.spawnProtectUntil = -1;
  world.applyPatchNote(world.content.notes.axes_auto_launch);
  world.setCommand('a', hold({ yaw: 0, pitch: 0 }));

  run(world, 60 * 2); // part-way to the next self-launch
  world.setCommand('a', hold({ weaponSlot: 1, yaw: 0, pitch: 0 }));
  world.step(1 / 60);
  assert.equal(a.weaponId, 'rifle');
  assert.equal(a.autoFireAt, 0, 'the rifle does not inherit the axe\'s clock');

  let fired = 0;
  world.events.on('autoFire', () => { fired += 1; });
  world.setCommand('a', hold({ yaw: 0, pitch: 0 }));
  run(world, 60 * 5);
  assert.equal(fired, 0, 'and the rifle never fires itself');
});

// --- axes are boomerangs ---------------------------------------------------

test('a boomerang curves instead of flying straight', () => {
  const straight = thrower(['axe']);
  straight.world.setCommand('a', hold({ fire: true, yaw: Math.PI, pitch: 0 }));
  straight.world.step(1 / 60);
  const plainStart = { ...straight.world.projectiles.projectiles[0].dir };
  run(straight.world, 20);
  const plain = straight.world.projectiles.projectiles[0];
  if (plain) {
    assert.ok(Math.abs(plain.dir.x - plainStart.x) < 0.2, 'sanity: a plain axe flies straight');
  }

  const bent = thrower(['axe'], 'axes_boomerang');
  bent.world.setCommand('a', hold({ fire: true, yaw: Math.PI, pitch: 0 }));
  bent.world.step(1 / 60);
  const id = bent.world.projectiles.projectiles[0].id;
  const start = { ...bent.world.projectiles.projectiles[0].dir };
  run(bent.world, 25);
  const curved = bent.world.projectiles.projectiles.find((q) => q.id === id);
  assert.ok(curved, 'it should still be flying');
  assert.ok(Math.abs(curved.dir.x - start.x) > 0.3,
    'the heading should have swung round by now');
  assert.ok(curved.turned > 0.5, `it should have logged its turn, got ${curved.turned}`);
});

test('a boomerang comes back', () => {
  const { world, a } = thrower(['axe'], 'axes_boomerang');
  world.setCommand('a', hold({ fire: true, yaw: Math.PI, pitch: 0 }));
  world.step(1 / 60);
  world.setCommand('a', hold({ yaw: Math.PI, pitch: 0 }));
  const id = world.projectiles.projectiles[0].id;

  let furthest = 0;
  let cameBack = false;
  for (let i = 0; i < 60 * 8; i++) {
    world.step(1 / 60);
    const p = world.projectiles.projectiles.find((q) => q.id === id);
    if (!p) break;
    const dist = Math.hypot(p.pos.x - a.position.x, p.pos.z - a.position.z);
    furthest = Math.max(furthest, dist);
    if (furthest > 6 && dist < 3) cameBack = true;
  }
  assert.ok(furthest > 6, `it should travel out first, got ${furthest.toFixed(1)}m`);
  assert.ok(cameBack, `it should return, furthest was ${furthest.toFixed(1)}m`);
});

test('a boomerang that has come round can hit the person who threw it', () => {
  const { world, a } = thrower(['axe'], 'axes_boomerang');
  world.setCommand('a', hold({ fire: true, yaw: Math.PI, pitch: 0 }));
  world.step(1 / 60);
  const p = world.projectiles.projectiles[0];
  assert.equal(p.ignoreOwner, true, 'it leaves your hand harmless to you');

  run(world, 40); // past a quarter turn
  const live = world.projectiles.projectiles.find((q) => q.id === p.id);
  assert.ok(live, 'still flying');
  assert.equal(live.ignoreOwner, false, 'once it has turned, it is your problem');
});

test('a boomerang hits a player rather than clattering off them', () => {
  const world = new World({ ...BASE, modeId: 'patch_notes', seed: 9 });
  const a = world.addActor({ id: 'a', name: 'A', characterId: 'grunt', loadout: ['axe'] });
  const b = world.addActor({ id: 'b', name: 'B', characterId: 'grunt', loadout: ['rifle'] });
  placeActor(world, a, -19, 0, -6);
  placeActor(world, b, -19, 0, 0);
  a.spawnProtectUntil = -1;
  b.spawnProtectUntil = -1;
  world.applyPatchNote(world.content.notes.axes_boomerang);

  world.projectiles.spawn({
    owner: 'a', weaponId: 'axe',
    origin: { x: -19, y: 1.0, z: -2 }, dir: { x: 0, y: 0, z: 1 },
  });
  run(world, 20);
  assert.ok(b.health < 100, `the boomerang should have connected, B is on ${b.health}`);
});

test('a grenade still clatters off a player, which is the other half of the rule', () => {
  const world = new World({ ...BASE });
  const a = world.addActor({
    id: 'a', name: 'A', characterId: 'grunt', loadout: ['grenade_launcher'],
  });
  const b = world.addActor({ id: 'b', name: 'B', characterId: 'grunt', loadout: ['rifle'] });
  placeActor(world, a, -19, 0, -6);
  placeActor(world, b, -19, 0, 0);
  a.spawnProtectUntil = -1;
  b.spawnProtectUntil = -1;

  let bounced = 0;
  world.events.on('projectileBounce', () => { bounced += 1; });
  world.projectiles.spawn({
    owner: 'a', weaponId: 'grenade_launcher',
    origin: { x: -19, y: 1.0, z: -2 }, dir: { x: 0, y: 0, z: 1 },
  });
  run(world, 20);
  assert.ok(bounced >= 1, 'a frag grenade bounces off a shin');
  assert.equal(b.health, 100, 'and does no damage doing it');
});
