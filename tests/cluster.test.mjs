import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BASE, placeActor, nodeReader } from './helpers.mjs';
import { World } from '../src/engine/sim/World.js';
import { loadContent } from '../src/data/Content.js';

/**
 * The cluster rule: a projectile that spawns projectiles. It is the recursion
 * primitive, so most of these tests are about the budget that stops it — a
 * weapon that clusters into itself is one missing decrement away from a fork
 * bomb.
 */

const hold = (extra = {}) => ({ forward: 0, strafe: 0, jump: false, fire: false, ...extra });
const run = (world, ticks) => { for (let i = 0; i < ticks; i++) world.step(1 / 60); };

function lobber(loadout = ['firework'], pitch = -0.35) {
  const world = new World({ ...BASE, modeId: 'patch_notes', seed: 5 });
  const a = world.addActor({ id: 'a', name: 'A', characterId: 'grunt', loadout });
  placeActor(world, a, -19, 0, 0);
  a.spawnProtectUntil = -1;
  a.setLook(Math.PI, pitch);
  return { world, a, pitch };
}

function counters(world) {
  const seen = { spawns: 0, clusters: 0, explosions: 0, children: 0, peak: 0 };
  world.events.on('projectileSpawn', () => { seen.spawns += 1; });
  world.events.on('projectileCluster', (e) => { seen.clusters += 1; seen.children += e.count; });
  world.events.on('explosion', () => { seen.explosions += 1; });
  return seen;
}

const fireOnce = (world, a, pitch) => {
  world.setCommand('a', hold({ fire: true, yaw: a.yaw, pitch }));
  world.step(1 / 60);
  world.setCommand('a', hold({ yaw: a.yaw, pitch }));
};

test('a clustering projectile bursts into the count its weapon asks for', () => {
  const { world, a, pitch } = lobber();
  const spec = world.content.weapons.firework.projectile.cluster;
  const seen = counters(world);

  fireOnce(world, a, pitch);
  run(world, 60 * 6);

  assert.equal(seen.clusters, 1, 'the shell should burst once');
  assert.equal(seen.children, spec.count);
  assert.equal(seen.spawns, 1 + spec.count, 'the shell, then its bomblets');
});

test('the generation budget is spent on the way down and stops the recursion', () => {
  // The firework clusters into itself. Without the decrement this never ends.
  const { world, a, pitch } = lobber();
  const seen = counters(world);
  fireOnce(world, a, pitch);
  run(world, 60 * 10);

  assert.equal(seen.clusters, 1, 'the children have no generations left to spend');
  const live = world.projectiles.projectiles.length;
  assert.equal(live, 0, `everything should have gone off, ${live} still in the air`);
});

test('a deeper budget recurses further, and still terminates', () => {
  const { world, a, pitch } = lobber();
  // Two generations of three: the shell, 3 children, 9 grandchildren.
  world.weapons.apply([
    { weapon: 'firework', path: 'projectile.cluster.count', op: 'set', value: 3 },
    { weapon: 'firework', path: 'projectile.cluster.generations', op: 'set', value: 2 },
  ]);
  const seen = counters(world);
  fireOnce(world, a, pitch);
  run(world, 60 * 14);

  assert.equal(seen.clusters, 1 + 3, 'the shell bursts, then each of its three children');
  assert.equal(seen.spawns, 1 + 3 + 9);
  assert.equal(world.projectiles.projectiles.length, 0, 'and it ends');
});

test('the generation cap holds even when a weapon asks for more', () => {
  const { world, a, pitch } = lobber();
  world.weapons.apply([
    { weapon: 'firework', path: 'projectile.cluster.count', op: 'set', value: 8 },
    { weapon: 'firework', path: 'projectile.cluster.generations', op: 'set', value: 99 },
  ]);
  const seen = counters(world);
  fireOnce(world, a, pitch);

  let peak = 0;
  for (let i = 0; i < 60 * 20; i++) {
    world.step(1 / 60);
    peak = Math.max(peak, world.projectiles.projectiles.length);
  }
  assert.ok(peak <= 160, `the live cap should hold, peaked at ${peak}`);
  assert.ok(seen.spawns < 5000, `a runaway would be far larger than ${seen.spawns}`);
  assert.equal(world.projectiles.projectiles.length, 0, 'and it still terminates');
});

test('"Rockets are grenades only": the thrown one does not go off, the child does', () => {
  const { world, a, pitch } = lobber(['rocket_launcher'], -0.35);
  world.applyPatchNote(world.content.notes.rockets_grenades_only);
  const seen = counters(world);

  fireOnce(world, a, pitch);
  run(world, 60 * 8);

  assert.equal(seen.clusters, 1, 'the thrown rocket should relaunch once');
  assert.equal(seen.children, 1, 'into exactly one rocket');
  assert.equal(seen.explosions, 1,
    'only the relaunched one explodes — the thrown one is a delivery mechanism');
});

test('a rocket thrown as a grenade arcs instead of flying flat', () => {
  const flat = lobber(['rocket_launcher'], 0);
  fireOnce(flat.world, flat.a, 0);
  flat.world.step(1 / 60);
  const straight = flat.world.projectiles.projectiles[0];
  assert.ok(Math.abs(straight.vel.y) < 1, 'sanity: a normal rocket does not fall');

  const thrown = lobber(['rocket_launcher'], 0);
  thrown.world.applyPatchNote(thrown.world.content.notes.rockets_grenades_only);
  fireOnce(thrown.world, thrown.a, 0);
  // Track the thrown one by id. Once it lands it relaunches, and the child is
  // thrown upwards at random — reading projectiles[0] later measures that
  // instead and reports the opposite of what this test is about.
  const id = thrown.world.projectiles.projectiles[0].id;
  let lobbed = null;
  for (let i = 0; i < 20; i++) {
    thrown.world.step(1 / 60);
    const found = thrown.world.projectiles.projectiles.find((q) => q.id === id);
    if (!found) break;
    lobbed = found;
  }
  assert.ok(lobbed, 'the thrown rocket should have been tracked');
  assert.ok(lobbed.vel.y < -1, `a thrown rocket should be falling, vy is ${lobbed.vel.y}`);
});

test('a bomblet can hit the person who fired the shell', () => {
  // The parent left your muzzle so it cannot hit you directly; its children
  // did not, and being caught by your own firework should be your own fault.
  const { world, a } = lobber();
  const child = world.projectiles.spawn({
    owner: 'a', weaponId: 'firework', origin: { x: -19, y: 3, z: 0 },
    dir: { x: 0, y: -1, z: 0 }, generations: 0, ignoreOwner: false,
  });
  assert.equal(child.ignoreOwner, false);

  const parent = world.projectiles.spawn({
    owner: 'a', weaponId: 'firework', origin: { x: -19, y: 3, z: 0 }, dir: { x: 0, y: -1, z: 0 },
  });
  assert.equal(parent.ignoreOwner, true, 'a muzzle-fired projectile still spares its owner');
});

test('the live projectile cap drops spawns rather than stalling the tick', () => {
  const { world } = lobber();
  let made = 0;
  for (let i = 0; i < 400; i++) {
    const p = world.projectiles.spawn({
      owner: 'a', weaponId: 'firework', origin: { x: -19, y: 20, z: 0 },
      dir: { x: 0, y: 1, z: 0 }, generations: 0,
    });
    if (p) made += 1;
  }
  assert.ok(made <= 160, `expected the cap to bite, made ${made}`);
  assert.equal(world.projectiles.projectiles.length, made);
});

test('content validation rejects a nonsense cluster', async () => {
  const base = JSON.parse(JSON.stringify(BASE.content.weapons.firework));
  const load = (patch) => {
    const doc = JSON.parse(JSON.stringify(base));
    Object.assign(doc.projectile.cluster, patch);
    return loadContent(async (path) => {
      if (path === 'weapons/firework.json') return doc;
      return nodeReader(path);
    });
  };
  await assert.rejects(() => load({ count: 0 }), /cluster\.count must be at least 1/);
  await assert.rejects(() => load({ generations: -1 }), /generations cannot be negative/);
  await assert.rejects(() => load({ direction: 'sideways' }),
    /direction must be random, reflect or forward/);
  await assert.rejects(() => load({ weapon: 'trebuchet' }),
    /clusters into unknown weapon "trebuchet"/);
  await load({});
});
