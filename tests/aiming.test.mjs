import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BASE, placeActor, stepFor } from './helpers.mjs';
import { World } from '../src/engine/sim/World.js';
import { fireWeapon } from '../src/engine/sim/weapons.js';

/**
 * Aiming down the sights is a simulation rule, not a camera effect: it has to
 * cost you speed and buy you accuracy, or the zoom is a lie.
 */

function makeWorld() {
  const world = new World({ ...BASE });
  const actor = world.addActor({
    id: 'p1', name: 'Tester', characterId: 'grunt', loadout: ['rifle', 'rocket_launcher'],
  });
  return { world, actor };
}

const idle = { forward: 0, strafe: 0, jump: false, fire: false };

/**
 * Peak horizontal speed over a short run from the middle of the arena. Each
 * call gets a fresh world: run the same actor twice and the second leg starts
 * wherever the first one finished, which in a 64 m room means a wall.
 */
function topSpeed(cmd) {
  const { world, actor } = makeWorld();
  placeActor(world, actor, 0, 0.1, 0);
  world.setCommand('p1', { ...idle, forward: 1, yaw: 0, ...cmd });
  let peak = 0;
  for (let i = 0; i < 90; i++) {
    world.step(1 / 60);
    peak = Math.max(peak, Math.hypot(actor.velocity.x, actor.velocity.z));
  }
  return peak;
}

test('aiming slows you to a walk, and letting go gives the speed back', () => {
  const aimed = topSpeed({ aim: true });
  const hip = topSpeed({ aim: false });

  assert.ok(aimed < hip * 0.7, `aimed ${aimed.toFixed(2)} should be well under hip ${hip.toFixed(2)}`);
  assert.ok(aimed > 1, 'aiming should still let you move, not root you');
});

test('crouching stays the slowest thing you can do, even while aiming', () => {
  const crouched = topSpeed({ crouch: true, aim: true });
  const aimed = topSpeed({ aim: true });

  assert.ok(crouched < aimed, `crouch ${crouched.toFixed(2)} should be under ads ${aimed.toFixed(2)}`);
});

test('the command carries aim onto the actor, and clearing it lets go', () => {
  const { world, actor } = makeWorld();
  placeActor(world, actor, 0, 0.1, 0);

  world.setCommand('p1', { ...idle, aim: true });
  world.step(1 / 60);
  assert.equal(actor.aiming, true);
  assert.equal(world.snapshot().actors.find((a) => a.id === 'p1').aiming, true,
    'the snapshot has to carry it, or no client can pose the model');

  world.setCommand('p1', { ...idle });
  world.step(1 / 60);
  assert.equal(actor.aiming, false);
});

test('a hitscan shot down the sights lands tighter than one from the hip', () => {
  const { world, actor } = makeWorld();
  // Standing still, so the moving penalty is not what is being measured.
  placeActor(world, actor, 0, 0.1, 20);
  world.setCommand('p1', { ...idle, yaw: 0, pitch: 0 });
  world.step(1 / 60);

  const rifle = world.content.weapons.rifle;
  const ctx = () => ({
    arena: world.arena, actors: world.actors, rules: world.rules, rng: world.rng, time: world.time,
  });

  const spreadOf = (aim) => {
    const angles = [];
    for (let i = 0; i < 80; i++) {
      actor.aiming = aim;
      const { claims } = fireWeapon(ctx(), actor, rifle, null);
      // Angular deviation from straight ahead, which is -Z at yaw 0.
      for (const c of claims) {
        if (c.kind === 'hitscan') angles.push(Math.acos(Math.max(-1, Math.min(1, -c.dir.z))));
      }
    }
    return angles.reduce((s, a) => s + a, 0) / Math.max(1, angles.length);
  };

  const hipSpread = spreadOf(false);
  const adsSpread = spreadOf(true);
  assert.ok(adsSpread < hipSpread,
    `ads ${adsSpread.toFixed(5)} rad should be tighter than hip ${hipSpread.toFixed(5)} rad`);
});
