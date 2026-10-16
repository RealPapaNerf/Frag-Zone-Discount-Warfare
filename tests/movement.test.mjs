import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BASE, placeActor } from './helpers.mjs';
import { World } from '../src/engine/sim/World.js';

function makeWorld(mutatorIds = []) {
  const world = new World({ ...BASE, mutatorIds });
  const actor = world.addActor({
    id: 'p1', name: 'Tester', characterId: 'grunt', loadout: ['rifle', 'rocket_launcher'],
  });
  return { world, actor };
}

const idle = { forward: 0, strafe: 0, jump: false, fire: false };

test('an actor falls and lands on the floor', () => {
  const { world, actor } = makeWorld();
  placeActor(world, actor, -5, 12, -12);
  world.setCommand('p1', idle);
  for (let i = 0; i < 180; i++) world.step(1 / 60);

  assert.ok(actor.grounded, 'expected to be standing');
  assert.ok(Math.abs(actor.position.y) < 0.05, `expected y≈0, got ${actor.position.y}`);
});

test('an actor cannot walk through a wall', () => {
  const { world, actor } = makeWorld();
  placeActor(world, actor, 0, 0.1, -28);
  world.setCommand('p1', { ...idle, forward: 1, yaw: 0 }); // yaw 0 faces -Z
  for (let i = 0; i < 240; i++) world.step(1 / 60);

  assert.ok(actor.position.z > -32, `clipped through the north wall to z=${actor.position.z}`);
});

test('walking into the stairs climbs onto the centre platform', () => {
  const { world, actor } = makeWorld();
  placeActor(world, actor, 0, 0.1, -16);
  // yaw 0 faces -Z, so face +Z (toward the arena centre) to reach the stairs.
  world.setCommand('p1', { ...idle, forward: 1, yaw: Math.PI });
  // Two seconds: long enough to climb, short enough not to cross the 16m
  // platform and walk off the far side.
  for (let i = 0; i < 120; i++) world.step(1 / 60);

  assert.ok(actor.position.y > 4.9,
    `expected to climb to the platform top (y≈5), got ${actor.position.y.toFixed(2)}`);
  assert.ok(actor.grounded, 'expected to be standing on the platform');
  assert.ok(Math.abs(actor.position.z) < 8, 'expected to still be on the platform');
});

test('a jump pad launches the actor onto the corner tower', () => {
  const { world, actor } = makeWorld();
  placeActor(world, actor, 14, 0.1, 14);
  world.setCommand('p1', idle);

  let peak = 0;
  for (let i = 0; i < 240; i++) {
    world.step(1 / 60);
    peak = Math.max(peak, actor.position.y);
  }
  assert.ok(peak > 9, `pad should clear the y=8 tower, peaked at ${peak.toFixed(2)}`);
  assert.ok(actor.position.y > 7.5,
    `expected to land on the tower, ended at ${actor.position.y.toFixed(2)}`);
});

test('low gravity makes jumps float higher', () => {
  const measure = (mutators) => {
    const { world, actor } = makeWorld(mutators);
    placeActor(world, actor, -5, 0.1, -12);
    world.setCommand('p1', idle);
    for (let i = 0; i < 30; i++) world.step(1 / 60); // settle on the floor
    world.setCommand('p1', { ...idle, jump: true });
    let peak = 0;
    for (let i = 0; i < 300; i++) {
      world.step(1 / 60);
      peak = Math.max(peak, actor.position.y);
    }
    return peak;
  };
  const normal = measure([]);
  const floaty = measure(['low_gravity']);
  assert.ok(normal > 1.5, `a normal jump should clear 1.5m, got ${normal.toFixed(2)}`);
  assert.ok(floaty > normal * 1.8,
    `low gravity should roughly double jump height: ${normal.toFixed(2)} -> ${floaty.toFixed(2)}`);
});

test('an actor that falls below the kill plane dies', () => {
  const { world, actor } = makeWorld();
  placeActor(world, actor, 0, -26, 0); // killZ is -25
  world.setCommand('p1', idle);
  world.step(1 / 60);
  assert.equal(actor.deaths, 1);
});
