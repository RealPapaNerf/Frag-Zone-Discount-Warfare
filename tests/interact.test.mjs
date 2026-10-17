import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BASE, placeActor } from './helpers.mjs';
import { World } from '../src/engine/sim/World.js';

/**
 * The use verb, and the two things it reaches: a door you look at, and a
 * fixture you stand at. Doors are the interesting half, because they are the
 * only geometry in the game that moves.
 */

const hold = (extra = {}) => ({ forward: 0, strafe: 0, jump: false, fire: false, ...extra });
const run = (world, ticks) => { for (let i = 0; i < ticks; i++) world.step(1 / 60); };

/** The garden's gate sits at z = 24, facing down Z. */
function atGate(offset = -2) {
  const world = new World({ ...BASE, mapId: 'garden', seed: 5 });
  const a = world.addActor({ id: 'a', name: 'A', characterId: 'grunt', loadout: ['rifle'] });
  placeActor(world, a, 0, 0, 24 + offset);
  a.spawnProtectUntil = -1;
  // Looking toward the gate.
  a.setLook(offset < 0 ? Math.PI : 0, 0);
  world.setCommand('a', hold({ yaw: a.yaw, pitch: 0 }));
  return { world, a, door: world.arena.doorById('garden_gate') };
}

const press = (world, a) => {
  world.setCommand('a', hold({ use: true, yaw: a.yaw, pitch: 0 }));
  world.step(1 / 60);
  world.setCommand('a', hold({ yaw: a.yaw, pitch: 0 }));
};

// --- doors -----------------------------------------------------------------

test('a map can have a door, and it starts shut', () => {
  const { world, door } = atGate();
  assert.ok(door, 'the garden has a gate');
  assert.equal(door.t, 0, 'closed');
  // Closed means solid: the query that collision and bullets both use must
  // return it.
  const found = world.arena.query(door.closedBox).some((b) => b.isDoor);
  assert.equal(found, true);
});

test('using a door opens it, and using it again shuts it', () => {
  const { world, a, door } = atGate();
  let toggles = 0;
  world.events.on('doorToggled', () => { toggles += 1; });

  press(world, a);
  assert.equal(door.target, 1, 'told to open');
  run(world, 90);
  assert.ok(door.t > 0.99, `it should be open, t=${door.t.toFixed(2)}`);

  press(world, a);
  run(world, 90);
  assert.ok(door.t < 0.01, 'and shut again');
  assert.equal(toggles, 2);
});

test('an open door stops being solid', () => {
  const { world, a, door } = atGate();
  const closedHit = world.arena.raycast({ x: 0, y: 1.5, z: 20 }, { x: 0, y: 0, z: 1 }, 8);
  assert.ok(closedHit?.brush?.isDoor, 'sanity: shut, it blocks');

  press(world, a);
  run(world, 90);
  const openHit = world.arena.raycast({ x: 0, y: 1.5, z: 20 }, { x: 0, y: 0, z: 1 }, 8);
  assert.ok(!openHit?.brush?.isDoor, 'open, the doorway is clear');
});

test('a door will not shut on somebody standing in it', () => {
  // A door that closes on you either shoves you through a wall or traps you
  // inside itself. Neither is a door.
  const { world, a, door } = atGate();
  press(world, a);
  run(world, 90);
  assert.ok(door.t > 0.99);

  placeActor(world, a, 0, 0, 24); // stand in the doorway
  press(world, a);
  run(world, 90);
  assert.ok(door.t > 0.99, `it should have held open, t=${door.t.toFixed(2)}`);

  placeActor(world, a, 0, 0, 21);
  run(world, 90);
  assert.ok(door.t < 0.01, 'and shut once the doorway is clear');
});

test('you cannot open a door from across the room', () => {
  const { world, a, door } = atGate(-14);
  press(world, a);
  assert.equal(door.target, 0, 'reach is short on purpose');
});

test('holding the key does not flap the door', () => {
  const { world, a, door } = atGate();
  let toggles = 0;
  world.events.on('doorToggled', () => { toggles += 1; });
  world.setCommand('a', hold({ use: true, yaw: a.yaw, pitch: 0 }));
  run(world, 60);
  assert.equal(toggles, 1, 'one press, one toggle');
  assert.equal(door.target, 1);
});

test('an unarmed player can still open doors', () => {
  const { world, a, door } = atGate();
  world.pickups.dropLoadout(a);
  assert.deepEqual(a.loadout, []);
  press(world, a);
  assert.equal(door.target, 1, 'getting back to your kit may mean going through one');
});

test('a closed door stops a bullet, an open one does not', () => {
  const { world, a } = atGate();
  const b = world.addActor({ id: 'b', name: 'B', characterId: 'grunt', loadout: ['rifle'] });
  placeActor(world, b, 0, 0, 28);
  b.spawnProtectUntil = -1;
  placeActor(world, a, 0, 0, 20);
  a.setLook(Math.PI, Math.atan2(0.9 - 1.6, 8));

  world.setCommand('a', hold({ fire: true, yaw: a.yaw, pitch: a.pitch }));
  run(world, 6);
  assert.equal(b.health, 100, 'the shut gate blocked it');

  placeActor(world, a, 0, 0, 22.2);
  press(world, a);
  run(world, 90);
  placeActor(world, a, 0, 0, 20);
  world.setCommand('a', hold({ fire: true, yaw: a.yaw, pitch: a.pitch }));
  run(world, 10);
  assert.ok(b.health < 100, 'through the open gate it connects');
});

// --- fixtures --------------------------------------------------------------

test('a fixture reports being used, which is the hook a lava lamp needs', () => {
  const world = new World({ ...BASE, mapId: 'garden', seed: 5 });
  const a = world.addActor({ id: 'a', name: 'A', characterId: 'grunt', loadout: ['rifle'] });
  const fixture = world.arena.fixtures[0];
  assert.ok(fixture, 'the garden has a socket');
  placeActor(world, a, fixture.pos.x, 0, fixture.pos.z + 0.6);
  a.spawnProtectUntil = -1;
  a.setLook(0, 0);

  const used = [];
  world.events.on('fixtureUsed', (e) => used.push(e));
  world.setCommand('a', hold({ use: true, yaw: 0, pitch: 0 }));
  world.step(1 / 60);

  assert.equal(used.length, 1);
  assert.equal(used[0].id, 'garden_socket');
  assert.equal(used[0].by, 'a');
});

test('a fixture is out of reach from across the garden', () => {
  const world = new World({ ...BASE, mapId: 'garden', seed: 5 });
  const a = world.addActor({ id: 'a', name: 'A', characterId: 'grunt', loadout: ['rifle'] });
  placeActor(world, a, 0, 0, 0);
  a.spawnProtectUntil = -1;
  let used = 0;
  world.events.on('fixtureUsed', () => { used += 1; });
  world.setCommand('a', hold({ use: true, yaw: 0, pitch: 0 }));
  world.step(1 / 60);
  assert.equal(used, 0);
});

// --- map pickups -----------------------------------------------------------

test('a map stocks its own pickups', () => {
  const world = new World({ ...BASE, mapId: 'garden', seed: 5 });
  world.addActor({ id: 'a', name: 'A', characterId: 'grunt', loadout: ['rifle'] });
  run(world, 2);
  assert.equal(world.pickups.items.length, world.arena.pickupSpawners.length,
    'every spawner should have put something out');
  assert.ok(world.pickups.items.some((p) => p.kind === 'health'));
  assert.ok(world.pickups.items.some((p) => p.kind === 'weapon'));
});

test('a map pickup comes back after it is taken', () => {
  const world = new World({ ...BASE, mapId: 'garden', seed: 5 });
  const a = world.addActor({ id: 'a', name: 'A', characterId: 'grunt', loadout: ['rifle'] });
  a.spawnProtectUntil = -1;
  world.setCommand('a', hold({ yaw: 0, pitch: 0 }));
  run(world, 2);

  const health = world.pickups.items.find((p) => p.kind === 'health');
  const spawner = world.arena.pickupSpawners.find((s) => s.kind === 'health');
  a.health = 50;
  placeActor(world, a, health.pos.x, 0, health.pos.z);
  run(world, 4);
  assert.ok(a.health > 50, 'taken');
  assert.equal(world.pickups.byId(health.id), null);

  placeActor(world, a, 0, 0, 0);
  a.health = 50;
  run(world, Math.ceil(spawner.respawnSec * 60) + 20);
  assert.ok(world.pickups.items.some((p) => p.kind === 'health' && p.pos.z === health.pos.z),
    'and it is back on its plinth');
});

test('a map with no doors or pickups is unaffected', () => {
  const world = new World({ ...BASE, mapId: 'blockout_arena' });
  assert.deepEqual(world.arena.doors, []);
  assert.deepEqual(world.arena.fixtures, []);
  assert.equal(world.pickups.items.length, 0);
  run(world, 60);
  assert.equal(world.pickups.items.length, 0);
});
