import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BASE, placeActor } from './helpers.mjs';
import { World } from '../src/engine/sim/World.js';
import { beamTickSec, perShotDamage } from '../src/engine/sim/weapons.js';

/**
 * A beam and a swing are the two weapons that are not "a bullet from the eye".
 * The beam is about damage arriving as a rate; the swing is about a cone
 * rather than a ray.
 */

const hold = (extra = {}) => ({ forward: 0, strafe: 0, jump: false, fire: false, ...extra });
const run = (world, ticks) => { for (let i = 0; i < ticks; i++) world.step(1 / 60); };

const LANE_X = -19;

/** Shooter facing the target down the clear lane, aimed at the chest. */
function duel(loadout, gap = 6, targetYaw = 0) {
  const world = new World({ ...BASE });
  const shooter = world.addActor({ id: 'a', name: 'A', characterId: 'grunt', loadout });
  const target = world.addActor({ id: 'b', name: 'B', characterId: 'grunt', loadout: ['rifle'] });
  placeActor(world, shooter, LANE_X, 0, -gap / 2);
  placeActor(world, target, LANE_X, 0, gap / 2);
  shooter.spawnProtectUntil = -1;
  target.spawnProtectUntil = -1;
  const pitch = Math.atan2(0.9 - 1.6, gap);
  shooter.setLook(Math.PI, pitch);
  target.setLook(targetYaw, 0);
  return { world, shooter, target, pitch };
}

const fire = (world, shooter, pitch, extra = {}) =>
  world.setCommand('a', hold({ fire: true, yaw: shooter.yaw, pitch, ...extra }));

// --- beam ------------------------------------------------------------------

test('a held beam applies damage once per tick, not once per trigger pull', () => {
  const { world, shooter, target, pitch } = duel(['beam']);
  const weapon = world.content.weapons.beam;
  let hits = 0;
  world.events.on('shot', (e) => { if (e.kind === 'beam') hits += 1; });

  fire(world, shooter, pitch);
  run(world, 60); // one second
  const expected = Math.round(1 / beamTickSec(weapon));
  assert.ok(Math.abs(hits - expected) <= 2,
    `expected about ${expected} beam ticks in a second, got ${hits}`);
  assert.ok(target.health < 100, 'and it should have hurt');
});

test('a beam does roughly its stated damage per second', () => {
  const { world, shooter, target, pitch } = duel(['beam']);
  const dps = world.content.weapons.beam.fire.damagePerSec;
  fire(world, shooter, pitch);
  run(world, 60);

  const dealt = 100 - target.health;
  // Rounding happens per application, so allow a little slack either way.
  assert.ok(Math.abs(dealt - dps) < dps * 0.15,
    `expected about ${dps} damage in a second, got ${dealt}`);
});

test('a beam stops at its range', () => {
  const range = BASE.content.weapons.beam.fire.range;
  const { world, shooter, target, pitch } = duel(['beam'], range + 12);
  fire(world, shooter, pitch);
  run(world, 60);
  assert.equal(target.health, 100, `a ${range} m beam should not reach past it`);
});

test('a beam drains its magazine and reloads like anything else', () => {
  const { world, shooter, pitch } = duel(['beam']);
  const size = world.content.weapons.beam.ammo.magazine;
  assert.equal(shooter.mag.beam, size);

  fire(world, shooter, pitch);
  run(world, 120);
  assert.ok(shooter.mag.beam < size, 'holding the trigger should spend rounds');

  // Burn the rest of the magazine and check it reloads on its own.
  run(world, 60 * 9);
  assert.ok(shooter.reload || shooter.mag.beam > 0,
    'an empty beam should have started reloading');
});

test('a beam states its damage as a rate, and the clamp agrees', () => {
  const weapon = BASE.content.weapons.beam;
  const perTick = perShotDamage(weapon);
  assert.ok(Math.abs(perTick - weapon.fire.damagePerSec * beamTickSec(weapon)) < 1e-9);
  // A hitscan weapon's per-shot damage is just its damage.
  assert.equal(perShotDamage(BASE.content.weapons.rifle), BASE.content.weapons.rifle.fire.damage);
});

// --- melee -----------------------------------------------------------------

test('a swing lands on someone in front of you', () => {
  const { world, shooter, target, pitch } = duel(['wrench'], 2.0);
  fire(world, shooter, pitch);
  world.step(1 / 60);
  assert.ok(target.health < 100, `expected the swing to land, target at ${target.health}`);
});

test('a swing misses someone out of reach', () => {
  const range = BASE.content.weapons.wrench.fire.range;
  const { world, shooter, target, pitch } = duel(['wrench'], range + 3);
  fire(world, shooter, pitch);
  run(world, 10);
  assert.equal(target.health, 100, 'a wrench is not a rifle');
});

test('a swing misses someone outside the arc', () => {
  const { world, shooter, target } = duel(['wrench'], 2.0);
  // Look 90 degrees away: still within reach, nowhere near the arc.
  shooter.setLook(Math.PI / 2, 0);
  world.setCommand('a', hold({ fire: true, yaw: Math.PI / 2, pitch: 0 }));
  run(world, 10);
  assert.equal(target.health, 100, 'the arc is a cone, not a sphere');
});

test('hitting someone from behind doubles the damage', () => {
  // Plenty of health on the dummy: damage is clamped to what the victim has
  // left, and a backstab one-shots a full-health fighter, which would make
  // the ratio read as 2.08x no matter what the multiplier says.
  const swing = (targetYaw) => {
    const d = duel(['wrench'], 2.0, targetYaw);
    d.target.health = 400;
    fire(d.world, d.shooter, d.pitch);
    d.world.step(1 / 60);
    return 400 - d.target.health;
  };

  const faceDamage = swing(0);          // facing the attacker
  const backDamage = swing(Math.PI);    // facing away

  const multiplier = BASE.content.weapons.wrench.fire.backstabMultiplier;
  assert.ok(faceDamage > 0, 'the control swing should have landed');
  assert.ok(Math.abs(backDamage / faceDamage - multiplier) < 0.1,
    `expected a ${multiplier}x backstab, got ${(backDamage / faceDamage).toFixed(2)}x`);
});

test('a swing reports itself as melee so the renderer draws no tracer', () => {
  const { world, shooter, pitch } = duel(['wrench'], 2.0);
  const kinds = [];
  world.events.on('shot', (e) => kinds.push(e.kind));
  fire(world, shooter, pitch);
  world.step(1 / 60);
  assert.deepEqual(kinds, ['melee']);
});

test('a backstab is flagged on the damage event', () => {
  const { world, shooter, pitch } = duel(['wrench'], 2.0, Math.PI);
  let flagged = null;
  world.events.on('damage', (e) => { flagged = e.backstab; });
  fire(world, shooter, pitch);
  world.step(1 / 60);
  assert.equal(flagged, true);
});

test('a wall between you and them stops the swing', () => {
  // The arena's centre platform is 16 m thick, so there is nowhere to stand
  // either side of it inside a 2.9 m reach. A purpose-built thin wall it is.
  const WALL_MAP = {
    schema: 1,
    id: 'wall_test',
    brushes: [
      { pos: [0, -0.5, 0], size: [40, 1, 40], material: 'floor' },
      { pos: [0, 1.5, 0], size: [8, 3, 0.4], material: 'wall' },
    ],
    spawns: [{ pos: [0, 0, -4], yaw: 0 }],
  };
  const content = { ...BASE.content, maps: { ...BASE.content.maps, wall_test: WALL_MAP } };
  const world = new World({ ...BASE, content, mapId: 'wall_test' });

  const shooter = world.addActor({ id: 'a', name: 'A', characterId: 'grunt', loadout: ['wrench'] });
  const target = world.addActor({ id: 'b', name: 'B', characterId: 'grunt', loadout: ['rifle'] });
  // 2.2 m apart with the wall (z = -0.2 .. 0.2) exactly between them.
  placeActor(world, shooter, 0, 0, -1.1);
  placeActor(world, target, 0, 0, 1.1);
  shooter.spawnProtectUntil = -1;
  target.spawnProtectUntil = -1;
  shooter.setLook(Math.PI, 0);

  world.setCommand('a', hold({ fire: true, yaw: Math.PI, pitch: 0 }));
  run(world, 10);
  assert.equal(target.health, 100, 'the wall should have blocked the swing');

  // Sanity: without the wall in the way the same swing lands, so the test is
  // measuring occlusion and not some accident of reach.
  const open = new World({ ...BASE, content, mapId: 'wall_test' });
  const a2 = open.addActor({ id: 'a', name: 'A', characterId: 'grunt', loadout: ['wrench'] });
  const b2 = open.addActor({ id: 'b', name: 'B', characterId: 'grunt', loadout: ['rifle'] });
  placeActor(open, a2, 0, 0, -6.1);
  placeActor(open, b2, 0, 0, -3.9);
  a2.spawnProtectUntil = -1;
  b2.spawnProtectUntil = -1;
  a2.setLook(Math.PI, 0);
  open.setCommand('a', hold({ fire: true, yaw: Math.PI, pitch: 0 }));
  run(open, 10);
  assert.ok(b2.health < 100, 'the same swing in the open should land');
});

test('a melee weapon needs no ammo and never reloads', () => {
  const { world, shooter, pitch } = duel(['wrench'], 2.0);
  fire(world, shooter, pitch);
  run(world, 60 * 5);
  assert.equal(shooter.reload, null, 'there is nothing to reload');
  assert.equal(shooter.ammo.wrench, 0);
});

test('the melee arc can sweep more than one target when a weapon says so', () => {
  const world = new World({ ...BASE });
  // Through the overlay, which is how a patch note would widen it too.
  world.weapons.apply([
    { weapon: 'wrench', path: 'fire.maxTargets', op: 'set', value: 3 },
    { weapon: 'wrench', path: 'fire.arcDeg', op: 'set', value: 180 },
  ]);

  const shooter = world.addActor({ id: 'a', name: 'A', characterId: 'grunt', loadout: ['wrench'] });
  const left = world.addActor({ id: 'l', name: 'L', characterId: 'grunt', loadout: ['rifle'] });
  const right = world.addActor({ id: 'r', name: 'R', characterId: 'grunt', loadout: ['rifle'] });
  placeActor(world, shooter, LANE_X, 0, 0);
  placeActor(world, left, LANE_X - 1.2, 0, 1.4);
  placeActor(world, right, LANE_X + 1.2, 0, 1.4);
  for (const a of [shooter, left, right]) a.spawnProtectUntil = -1;
  shooter.setLook(Math.PI, 0);

  world.setCommand('a', hold({ fire: true, yaw: Math.PI, pitch: 0 }));
  world.step(1 / 60);
  assert.ok(left.health < 100, 'the left target should have been caught');
  assert.ok(right.health < 100, 'and the right one too');
});
