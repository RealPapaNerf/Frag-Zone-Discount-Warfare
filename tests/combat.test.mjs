import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BASE, placeActor } from './helpers.mjs';
import { World } from '../src/engine/sim/World.js';
import { explode } from '../src/engine/sim/damage.js';

/**
 * Two actors on open floor, `gap` metres apart, shooter facing the target.
 * The lane runs along Z at x = -19, which is clear of the centre platform,
 * the stairs and every crate.
 */
function duel(mutatorIds = [], gap = 12) {
  const world = new World({ ...BASE, mutatorIds });
  const shooter = world.addActor({
    id: 'a', name: 'Shooter', characterId: 'grunt', loadout: ['rifle', 'rocket_launcher'],
  });
  const target = world.addActor({
    id: 'b', name: 'Target', characterId: 'grunt', loadout: ['rifle'],
  });
  const LANE_X = -19;
  placeActor(world, shooter, LANE_X, 0, -gap / 2);
  placeActor(world, target, LANE_X, 0, gap / 2);
  // Spawn protection would swallow the first hit.
  shooter.spawnProtectUntil = -1;
  target.spawnProtectUntil = -1;
  // yaw = PI looks down +Z, toward the target.
  shooter.setLook(Math.PI, 0);
  target.setLook(0, 0);
  return { world, shooter, target };
}

const hold = (extra = {}) => ({ forward: 0, strafe: 0, jump: false, fire: false, ...extra });

test('a hitscan shot damages a target in the open', () => {
  const { world, shooter, target } = duel();
  shooter.setLook(Math.PI, Math.atan2(0.89 - 1.6, 12)); // aim at chest
  world.setCommand('a', hold({ fire: true, yaw: shooter.yaw, pitch: shooter.pitch }));
  world.step(1 / 60);

  assert.ok(target.health < 100, `expected damage, target still at ${target.health}`);
  assert.equal(target.health, 100 - 17);
});

test('the centre platform stops a shot that would otherwise connect', () => {
  const world = new World({ ...BASE });
  const shooter = world.addActor({ id: 'a', name: 'A', characterId: 'grunt', loadout: ['rifle'] });
  const target = world.addActor({ id: 'b', name: 'B', characterId: 'grunt', loadout: ['rifle'] });
  placeActor(world, shooter, -20, 0, 0);
  placeActor(world, target, 20, 0, 0);
  shooter.spawnProtectUntil = -1;
  target.spawnProtectUntil = -1;
  shooter.setLook(-Math.PI / 2, 0);

  world.setCommand('a', hold({ fire: true, yaw: shooter.yaw, pitch: 0 }));
  world.step(1 / 60);
  assert.equal(target.health, 100, 'the platform should have blocked the shot');
});

test('headshots apply the weapon multiplier', () => {
  const { world, shooter, target } = duel();
  const headY = target.position.y + target.hitbox.height - target.hitbox.headHeight * 0.5;
  shooter.setLook(Math.PI, Math.atan2(headY - 1.6, 12));
  world.setCommand('a', hold({ fire: true, yaw: shooter.yaw, pitch: shooter.pitch }));
  world.step(1 / 60);

  assert.equal(target.health, 100 - 34, 'expected a 2x headshot');
});

test('big heads genuinely grows the head hitbox, not just the model', () => {
  const aimAbove = (mutators) => {
    const { world, shooter, target } = duel(mutators);
    // Aim a little over the top of a normal head.
    const aimY = target.position.y + target.hitbox.height + 0.22;
    shooter.setLook(Math.PI, Math.atan2(aimY - 1.6, 12));
    world.setCommand('a', hold({ fire: true, yaw: shooter.yaw, pitch: shooter.pitch }));
    world.step(1 / 60);
    return target.health;
  };
  assert.equal(aimAbove([]), 100, 'that shot should sail over a normal head');
  assert.ok(aimAbove(['big_heads']) < 100, 'big heads should have caught it');
});

test('a rocket at your feet splashes, hurts and shoves you', () => {
  const { world, shooter, target } = duel([], 10);
  shooter.switchWeapon(1);
  // Aim at the floor 2.5m short of the target: close enough to splash, far
  // enough that it is not simply a direct hit.
  const impactZ = target.position.z - 2.5;
  const pitch = Math.atan2(-1.6, impactZ - shooter.position.z);
  shooter.setLook(Math.PI, pitch);

  world.setCommand('a', hold({ fire: true, yaw: Math.PI, pitch }));
  world.step(1 / 60);
  world.setCommand('a', hold({ yaw: Math.PI, pitch }));
  for (let i = 0; i < 30; i++) world.step(1 / 60);

  assert.ok(target.health < 100, 'the blast should have hurt them');
  assert.ok(target.health > 0, 'a near miss should not be an instant kill');
  assert.ok(target.position.z > 5.3,
    `the blast should have shoved them away, z=${target.position.z.toFixed(2)}`);
});

test('a direct rocket hit is far deadlier than the splash alone', () => {
  const { world, shooter, target } = duel([], 10);
  shooter.switchWeapon(1);
  const pitch = Math.atan2(0.89 - 1.6, 10);
  shooter.setLook(Math.PI, pitch);
  world.setCommand('a', hold({ fire: true, yaw: Math.PI, pitch }));
  world.step(1 / 60);
  world.setCommand('a', hold({ yaw: Math.PI, pitch }));
  for (let i = 0; i < 30; i++) world.step(1 / 60);

  assert.equal(target.alive, false, 'a direct rocket should kill a full-health target');
  assert.equal(shooter.score, 1);
});

test('rocket jumping launches you high while halving the self damage', () => {
  const world = new World({ ...BASE });
  const player = world.addActor({
    id: 'a', name: 'Jumper', characterId: 'grunt', loadout: ['rocket_launcher'],
  });
  placeActor(world, player, -5, 0, -12);
  player.spawnProtectUntil = -1;
  world.setCommand('a', hold({ yaw: 0, pitch: 0 }));
  for (let i = 0; i < 20; i++) world.step(1 / 60); // settle on the floor
  assert.ok(player.grounded);

  // Look straight down and fire.
  const down = -Math.PI / 2 + 0.02;
  world.setCommand('a', hold({ fire: true, jump: true, yaw: 0, pitch: down }));
  world.step(1 / 60);
  world.setCommand('a', hold({ yaw: 0, pitch: down }));

  let peak = 0;
  for (let i = 0; i < 120; i++) {
    world.step(1 / 60);
    peak = Math.max(peak, player.position.y);
  }

  assert.ok(player.health < 100, 'a rocket jump should cost health');
  assert.ok(player.health > 45,
    `self damage should be scaled down, left ${player.health}`);
  assert.ok(peak > 5,
    `expected a big launch, only reached ${peak.toFixed(2)}m`);
});

test('a wall between you and the blast absorbs it', () => {
  const world = new World({ ...BASE });
  const victim = world.addActor({ id: 'v', name: 'V', characterId: 'grunt', loadout: ['rifle'] });
  // Stand just inside the centre platform's east face; detonate on its west face.
  placeActor(world, victim, 9.2, 0, 0);
  victim.spawnProtectUntil = -1;

  explode(world, {
    point: { x: -9.2, y: 1, z: 0 },
    weapon: world.content.weapons.rocket_launcher,
    owner: null,
  });
  assert.equal(victim.health, 100, 'the platform should have shielded them');
});

test('firing respects the rate of change and consumes ammo', () => {
  const { world, shooter } = duel();
  const startAmmo = shooter.ammo.rifle;
  const cmd = hold({ fire: true, yaw: shooter.yaw, pitch: 0 });

  world.setCommand('a', cmd);
  for (let i = 0; i < 60; i++) world.step(1 / 60); // one second at 560 rpm
  const spent = startAmmo - shooter.ammo.rifle;
  assert.ok(spent >= 8 && spent <= 10, `expected ~9 shots in a second, got ${spent}`);
});

test('a semi-automatic weapon needs the trigger released between shots', () => {
  const { world, shooter } = duel();
  shooter.switchWeapon(1);
  const startAmmo = shooter.ammo.rocket_launcher;
  world.setCommand('a', hold({ fire: true, yaw: shooter.yaw, pitch: 0 }));
  for (let i = 0; i < 30; i++) world.step(1 / 60);
  assert.equal(startAmmo - shooter.ammo.rocket_launcher, 1, 'held trigger should fire once');
});

test('infinite ammo from a mutator stops the counter dropping', () => {
  const { world, shooter } = duel(['rocket_arena']);
  assert.deepEqual(shooter.loadout, ['rocket_launcher'], 'the mutator forces the loadout');
  const start = shooter.ammo.rocket_launcher;
  world.setCommand('a', hold({ fire: true, yaw: shooter.yaw, pitch: 0 }));
  for (let i = 0; i < 120; i++) world.step(1 / 60);
  assert.equal(shooter.ammo.rocket_launcher, start);
});
