import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BASE, placeActor } from './helpers.mjs';
import { World } from '../src/engine/sim/World.js';

/**
 * Dropping and picking up are the same system from two ends. The interesting
 * cases are the ones where a round trip has to preserve something: the ammo
 * that was in the magazine, and the fact that losing your guns was supposed
 * to cost you.
 */

const hold = (extra = {}) => ({ forward: 0, strafe: 0, jump: false, fire: false, ...extra });
const run = (world, ticks) => { for (let i = 0; i < ticks; i++) world.step(1 / 60); };

function carrier(loadout = ['rifle', 'axe', 'rocket_launcher']) {
  const world = new World({ ...BASE, seed: 11 });
  const a = world.addActor({ id: 'a', name: 'A', characterId: 'grunt', loadout });
  const b = world.addActor({ id: 'b', name: 'B', characterId: 'grunt', loadout: ['rifle'] });
  placeActor(world, a, -19, 0, 0);
  placeActor(world, b, -19, 0, 14);
  a.spawnProtectUntil = -1;
  b.spawnProtectUntil = -1;
  world.setCommand('a', hold({ yaw: 0, pitch: 0 }));
  world.setCommand('b', hold({ yaw: 0, pitch: 0 }));
  return { world, a, b };
}

const stand = (actor, item) => {
  actor.position.x = item.pos.x;
  actor.position.z = item.pos.z;
};

// --- dropping --------------------------------------------------------------

test('dropping leaves you with nothing and the floor with everything', () => {
  const { world, a } = carrier();
  world.pickups.dropLoadout(a);

  assert.deepEqual(a.loadout, [], 'empty handed');
  assert.equal(world.pickups.items.length, 3, 'all three on the floor');
  assert.equal(world.weaponById(a.weaponId), null, 'and nothing to fire');
});

test('an empty-handed actor is harmless rather than broken', () => {
  const { world, a } = carrier();
  world.pickups.dropLoadout(a);
  let fired = 0;
  world.events.on('fire', () => { fired += 1; });

  world.setCommand('a', hold({ fire: true, yaw: 0, pitch: 0 }));
  run(world, 60);
  assert.equal(fired, 0, 'no weapon, no shots, no crash');
  assert.equal(a.alive, true);
});

test('a dropped weapon keeps the ammunition it had', () => {
  const { world, a } = carrier();
  a.mag.rifle = 7;
  a.ammo.rifle = 55;
  world.pickups.dropLoadout(a);

  const rifle = world.pickups.items.find((p) => p.weaponId === 'rifle');
  assert.equal(rifle.mag, 7);
  assert.equal(rifle.reserve, 55);
  assert.equal(a.mag.rifle, undefined, 'and the actor no longer has it');
});

test('picking your own weapon back up restores exactly what you lost', () => {
  const { world, a } = carrier(['rifle']);
  a.mag.rifle = 7;
  a.ammo.rifle = 55;
  world.pickups.dropLoadout(a, { ownerDelaySec: 0.3 });
  run(world, 40);

  stand(a, world.pickups.items[0]);
  run(world, 4);
  assert.deepEqual(a.loadout, ['rifle']);
  assert.equal(a.mag.rifle, 7, 'the magazine comes back as it went');
  assert.equal(a.ammo.rifle, 55);
});

test('you cannot instantly re-collect what you just dropped', () => {
  // The scatter is smaller than the radius you collect from, so without an
  // owner delay a player who drops everything and stands still gets it all
  // straight back and the wet floor sign costs them nothing.
  const { world, a } = carrier();
  world.pickups.dropLoadout(a, { ownerDelaySec: 3 });

  for (const item of [...world.pickups.items]) {
    stand(a, item);
    run(world, 6);
  }
  assert.deepEqual(a.loadout, [], 'still empty handed');
  assert.equal(world.pickups.items.length, 3, 'and it is all still on the floor');

  run(world, 60 * 3);
  for (const item of [...world.pickups.items]) {
    stand(a, item);
    run(world, 6);
  }
  assert.equal(a.loadout.length, 3, 'once the delay is up they can gather it');
});

test('somebody else can take your weapons straight away', () => {
  const { world, a, b } = carrier(['rifle']);
  world.pickups.dropLoadout(a, { ownerDelaySec: 5 });
  run(world, 40); // past the short global grace, well inside the owner delay

  const item = world.pickups.items[0];
  stand(b, item);
  run(world, 6);
  assert.ok(b.loadout.includes('rifle'), 'first refusal goes to everyone else');
  assert.deepEqual(a.loadout, [], 'while the owner is still waiting');
});

// --- picking up ------------------------------------------------------------

test('a weapon you already carry arrives as ammunition', () => {
  const { world, a } = carrier(['rifle']);
  a.ammo.rifle = 10;
  const before = a.loadout.length;
  world.pickups.spawn({
    kind: 'weapon', weaponId: 'rifle', mag: 10, reserve: 20,
    pos: { ...a.position },
  });
  run(world, 4);

  assert.equal(a.loadout.length, before, 'you do not carry two rifles');
  assert.equal(a.ammo.rifle, 40, 'its rounds went into your pouch');
});

test('a weapon you do not carry joins the loadout, without yanking you off yours', () => {
  const { world, a } = carrier(['rifle']);
  const held = a.weaponId;
  world.pickups.spawn({ kind: 'weapon', weaponId: 'shotgun', mag: 6, reserve: 20, pos: { ...a.position } });
  run(world, 4);

  assert.deepEqual(a.loadout, ['rifle', 'shotgun']);
  assert.equal(a.weaponId, held, 'it does not switch you mid-fight');
  assert.equal(a.mag.shotgun, 6, 'and it arrives loaded as it was');
});

test('an empty-handed actor switches to whatever they pick up', () => {
  const { world, a } = carrier();
  world.pickups.dropLoadout(a, { ownerDelaySec: 0 });
  run(world, 30);
  world.pickups.spawn({ kind: 'weapon', weaponId: 'shotgun', mag: 6, reserve: 20, pos: { ...a.position } });
  run(world, 4);
  assert.equal(a.weaponId, 'shotgun', 'with nothing in your hands you take what you find');
});

test('a full loadout swaps rather than hoards, and drops what it swapped', () => {
  const { world, a } = carrier();
  assert.equal(a.loadout.length, world.rules.maxWeapons);
  const held = a.weaponId;

  world.pickups.spawn({ kind: 'weapon', weaponId: 'shotgun', mag: 6, reserve: 20, pos: { ...a.position } });
  run(world, 4);

  assert.equal(a.loadout.length, world.rules.maxWeapons, 'still at the limit');
  assert.ok(a.loadout.includes('shotgun'));
  assert.ok(!a.loadout.includes(held), 'the one you were holding went');
  assert.ok(world.pickups.items.some((p) => p.weaponId === held),
    'and it is on the floor where the new one was');
});

test('health is left for somebody who needs it', () => {
  const { world, a } = carrier();
  world.pickups.spawn({ kind: 'health', amount: 35, pos: { ...a.position } });
  run(world, 6);
  assert.equal(world.pickups.items.length, 1, 'on full health, leave it');

  a.health = 40;
  run(world, 6);
  assert.equal(a.health, 75);
  assert.equal(world.pickups.items.length, 0);
});

test('an ammo pickup respects the weapon carry limit', () => {
  const { world, a } = carrier(['rifle']);
  const cap = world.weaponById('rifle').ammo.max;
  a.mag.rifle = 0;
  a.ammo.rifle = cap - 5;
  world.pickups.spawn({ kind: 'ammo', weaponId: 'rifle', amount: 500, pos: { ...a.position } });
  run(world, 6);
  assert.equal(a.ammo.rifle + a.mag.rifle, cap, 'topped up to the cap and no further');
});

test('ammo for a weapon you do not carry is left alone', () => {
  const { world, a } = carrier(['rifle']);
  world.pickups.spawn({ kind: 'ammo', weaponId: 'shotgun', amount: 20, pos: { ...a.position } });
  run(world, 6);
  assert.equal(world.pickups.items.length, 1);
});

test('pickups expire', () => {
  const { world, a } = carrier(['rifle']);
  world.pickups.spawn({ kind: 'weapon', weaponId: 'shotgun', mag: 1, reserve: 1, lifetimeSec: 2,
    pos: { x: -19, y: 0, z: 40 } });
  assert.equal(world.pickups.items.length, 1);
  run(world, 60 * 3);
  assert.equal(world.pickups.items.length, 0);
});

// --- the wet floor sign ----------------------------------------------------

test('a wet floor sign takes everything you are carrying', () => {
  const world = new World({ ...BASE, seed: 11 });
  const a = world.addActor({
    id: 'a', name: 'A', characterId: 'grunt', loadout: ['rifle', 'axe', 'rocket_launcher'],
  });
  placeActor(world, a, -19, 0, 0);
  a.spawnProtectUntil = -1;
  world.setCommand('a', hold({ yaw: 0, pitch: 0 }));

  world.deployables.place({ owner: 'b', deployableId: 'wet_floor_sign', pos: { x: -19, y: 0, z: 0 } });
  run(world, 40);

  assert.deepEqual(a.loadout, [], 'grenades, melee, primary, secondary — the lot');
  assert.equal(world.pickups.items.length, 3);
  assert.equal(a.hasEffect('slipped'), true);
  assert.equal(a.health, 100, 'and it still does no damage');
});

test('dying drops your loadout only when the rules say so', () => {
  const plain = carrier(['rifle']);
  plain.world.killActor(plain.a, { attacker: 'b', weapon: 'rifle', cause: 'weapon' });
  assert.equal(plain.world.pickups.items.length, 0, 'deathmatch is unchanged');

  const dropping = carrier(['rifle']);
  dropping.world.rules.dropOnDeath = true;
  dropping.world.killActor(dropping.a, { attacker: 'b', weapon: 'rifle', cause: 'weapon' });
  assert.equal(dropping.world.pickups.items.length, 1);
});

test('respawning gives you your loadout back', () => {
  const { world, a } = carrier(['rifle', 'axe']);
  world.pickups.dropLoadout(a);
  assert.deepEqual(a.loadout, []);

  // A respawn rebuilds from the loadout the actor joined with, so losing
  // everything is a setback for a life rather than for the match.
  world.respawn(a);
  assert.ok(a.loadout.length > 0, 'you come back armed');
  assert.ok(a.mag[a.weaponId] !== undefined || a.ammo[a.weaponId] !== undefined);
});

test('the snapshot carries pickups for the renderer', () => {
  const { world, a } = carrier(['rifle']);
  world.pickups.dropLoadout(a, { ownerDelaySec: 2 });
  const snap = world.snapshot().pickups;
  assert.equal(snap.length, 1);
  assert.equal(snap[0].kind, 'weapon');
  assert.equal(snap[0].weaponId, 'rifle');
  assert.equal(snap[0].owner, 'a');
});
