import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BASE, placeActor, nodeReader } from './helpers.mjs';
import { World } from '../src/engine/sim/World.js';
import { loadContent } from '../src/data/Content.js';

/**
 * Things left on the floor. The arming delay is the load-bearing piece of
 * design: without it, dropping a trap under someone is the same as shooting
 * them, and every trap weapon collapses into a bad shotgun.
 */

const hold = (extra = {}) => ({ forward: 0, strafe: 0, jump: false, fire: false, ...extra });
const run = (world, ticks) => { for (let i = 0; i < ticks; i++) world.step(1 / 60); };

function field(loadout = ['grill']) {
  const world = new World({ ...BASE, seed: 4 });
  const a = world.addActor({ id: 'a', name: 'A', characterId: 'grunt', loadout });
  const b = world.addActor({ id: 'b', name: 'B', characterId: 'grunt', loadout: ['rifle'] });
  placeActor(world, a, -19, 0, -4);
  placeActor(world, b, -19, 0, 8);
  a.spawnProtectUntil = -1;
  b.spawnProtectUntil = -1;
  a.setLook(Math.PI, 0);
  world.setCommand('b', hold({ yaw: 0, pitch: 0 }));
  return { world, a, b };
}

/** Put one down and stop pressing the button. */
function deploy(world) {
  world.setCommand('a', hold({ fire: true, yaw: Math.PI, pitch: 0 }));
  world.step(1 / 60);
  world.setCommand('a', hold({ yaw: Math.PI, pitch: 0 }));
  return world.deployables.items[world.deployables.items.length - 1];
}

const standOn = (actor, item) => {
  actor.position.x = item.pos.x;
  actor.position.z = item.pos.z;
};

// --- placing ---------------------------------------------------------------

test('a deploy weapon puts something on the floor in front of you', () => {
  const { world, a } = field();
  const item = deploy(world);
  assert.ok(item, 'something should have been placed');
  assert.equal(item.owner, 'a');
  assert.ok(Math.abs(item.pos.z - a.position.z) > 1, 'in front of them, not inside them');
  assert.ok(Math.abs(item.pos.y - a.position.y) < 1.5, 'and on the ground, not in the air');
});

test('a trap does nothing until it has armed', () => {
  const { world, b } = field();
  const item = deploy(world);
  const armDelay = world.content.deployables.grill.armTimeSec;
  assert.ok(armDelay > 0, 'the grill is supposed to take a moment');

  standOn(b, item);
  run(world, Math.floor(armDelay * 60) - 6);
  assert.equal(b.health, 100, 'standing on an unarmed grill is standing on a grill');
  assert.equal(world.deployables.items.length, 1);

  run(world, 20);
  assert.ok(b.health < 100, 'once armed it should go off');
});

test('placing more than your allowance replaces your oldest', () => {
  const { world } = field();
  const allowance = world.content.deployables.grill.maxActive;
  for (let i = 0; i < allowance + 2; i++) {
    deploy(world);
    run(world, 60); // past the weapon's own rate limit
  }
  assert.equal(world.deployables.ownedBy('a').length, allowance,
    'you cannot carpet the map');
});

test('one kind of deployable does not evict another', () => {
  // The rotisserie has an allowance of one. Counting everything a player owns
  // rather than everything of that type meant placing a turret silently binned
  // the grill they left two rooms away.
  const world = new World({ ...BASE, seed: 4 });
  const a = world.addActor({ id: 'a', name: 'A', characterId: 'grunt', loadout: ['rifle'] });
  placeActor(world, a, -19, 0, 0);

  world.deployables.place({ owner: 'a', deployableId: 'grill', pos: { x: -19, y: 0, z: -2 } });
  world.deployables.place({ owner: 'a', deployableId: 'rotisserie', pos: { x: -19, y: 0, z: 2 } });

  const kinds = world.deployables.ownedBy('a').map((d) => d.defId).sort();
  assert.deepEqual(kinds, ['grill', 'rotisserie'], 'both should still be there');

  // A second rotisserie does replace the first, because that is its own limit.
  world.deployables.place({ owner: 'a', deployableId: 'rotisserie', pos: { x: -19, y: 0, z: 4 } });
  assert.equal(world.deployables.ownedBy('a', 'rotisserie').length, 1);
  assert.equal(world.deployables.ownedBy('a', 'grill').length, 1, 'and the grill is untouched');
});

test('leaving the match takes your litter with you', () => {
  const { world } = field();
  deploy(world);
  assert.equal(world.deployables.items.length, 1);
  world.removeActor('a');
  assert.equal(world.deployables.items.length, 0);
});

test('a deployable expires on its own', () => {
  const { world } = field();
  const item = deploy(world);
  const life = world.content.deployables.grill.lifetimeSec;
  let reason = null;
  world.events.on('deployableRemoved', (e) => { reason = e.reason; });
  run(world, Math.ceil(life * 60) + 10);
  assert.equal(world.deployables.byId(item.id), null);
  assert.equal(reason, 'expired');
});

// --- proximity traps -------------------------------------------------------

test('a grill flattens whoever steps on it, then is gone', () => {
  const { world, b } = field();
  const item = deploy(world);
  run(world, 70); // arm it
  standOn(b, item);
  run(world, 4);

  assert.ok(b.health < 50, `expected a flattening, B is on ${b.health}`);
  assert.equal(b.hasEffect('pinned'), true, 'and pinned where they stood');
  assert.equal(world.deployables.items.length, 0, 'a one-shot trap is spent');
});

test('your own grill does not care that it is yours', () => {
  const { world, a } = field();
  const item = deploy(world);
  run(world, 70);
  standOn(a, item);
  run(world, 4);
  assert.ok(a.health < 100, 'it flattens you too');
});

test('a wet floor sign is a hazard rather than a weapon, and stays put', () => {
  const { world, b } = field(['wet_floor_sign']);
  const item = deploy(world);
  run(world, 30);
  standOn(b, item);
  run(world, 4);

  assert.equal(b.health, 100, 'it does no damage at all');
  assert.equal(b.hasEffect('slipped'), true);
  assert.equal(b.mods.canFire, false, 'you are on the floor');
  assert.equal(b.mods.canMove, false);
  assert.equal(world.deployables.items.length, 1, 'and the sign is still standing');
});

test('a repeating trap waits out its cooldown instead of firing every tick', () => {
  const { world, b } = field(['wet_floor_sign']);
  const item = deploy(world);
  const cooldown = world.content.deployables.wet_floor_sign.trigger.cooldownSec;
  run(world, 30);

  let triggers = 0;
  world.events.on('deployableTriggered', () => { triggers += 1; });
  standOn(b, item);
  run(world, Math.round(cooldown * 60 * 2.2));
  assert.ok(triggers >= 2 && triggers <= 4,
    `expected a few triggers over two cooldowns, got ${triggers}`);
});

// --- turrets ---------------------------------------------------------------

test('a turret finds a target on its own and shoots it', () => {
  const { world, b } = field(['rotisserie']);
  deploy(world);
  let shots = 0;
  world.events.on('deployableFired', () => { shots += 1; });

  placeActor(world, b, -19, 0, 2);
  run(world, 60 * 5);
  assert.ok(shots >= 3, `expected the turret to keep firing, got ${shots}`);
  assert.ok(b.health < 100, 'and to hit something');
});

test('a turret does not shoot the person who put it down', () => {
  const { world, a, b } = field(['rotisserie']);
  deploy(world);
  // Take the other target out of the picture entirely.
  world.removeActor('b');
  let shots = 0;
  world.events.on('deployableFired', () => { shots += 1; });
  run(world, 60 * 5);
  assert.equal(shots, 0, 'with only its owner in range it should hold fire');
  assert.equal(a.health, 100);
});

test('a turret will not shoot through a wall', () => {
  const { world, b } = field(['rotisserie']);
  deploy(world);
  let shots = 0;
  world.events.on('deployableFired', () => { shots += 1; });
  // The far side of the centre platform, which blocks shots in every other test.
  placeActor(world, b, 20, 0, 0);
  run(world, 60 * 4);
  assert.equal(shots, 0, 'line of sight is checked');
});

// --- shooting them ---------------------------------------------------------

test('you can shoot a deployable down', () => {
  const { world, b } = field(['rotisserie']);
  const item = deploy(world);
  let destroyedBy = null;
  world.events.on('deployableRemoved', (e) => {
    if (e.reason === 'destroyed') destroyedBy = e.attacker;
  });

  placeActor(world, b, item.pos.x, 0, item.pos.z + 6);
  b.setLook(0, Math.atan2(0.45 - 1.6, 6));
  world.setCommand('b', hold({ fire: true, yaw: b.yaw, pitch: b.pitch }));
  run(world, 60 * 3);

  assert.equal(destroyedBy, 'b', 'the turret should have been shot down');
  assert.equal(world.deployables.items.length, 0);
});

test('a player standing in front of their turret takes the shot', () => {
  const { world, a, b } = field(['rotisserie']);
  const item = deploy(world);
  // A directly between the shooter and the turret.
  placeActor(world, b, item.pos.x, 0, item.pos.z + 8);
  placeActor(world, a, item.pos.x, 0, item.pos.z + 4);
  b.setLook(0, Math.atan2(0.9 - 1.6, 8));
  world.setCommand('b', hold({ fire: true, yaw: b.yaw, pitch: b.pitch }));
  run(world, 10);

  assert.ok(a.health < 100, 'the person in the way is hit, not the thing behind them');
  assert.equal(world.deployables.items.length, 1, 'and the turret is untouched');
});

test('a blast takes out what people left lying about', () => {
  const { world, a } = field(['rotisserie']);
  const item = deploy(world);
  let destroyed = false;
  world.events.on('deployableRemoved', (e) => { if (e.reason === 'destroyed') destroyed = true; });

  // A rocket at the turret's feet.
  a.loadout = ['rocket_launcher'];
  world.projectiles.spawn({
    owner: 'b', weaponId: 'rocket_launcher',
    origin: { x: item.pos.x, y: item.pos.y + 3, z: item.pos.z },
    dir: { x: 0, y: -1, z: 0 },
  });
  run(world, 30);
  assert.equal(destroyed, true, 'a grenade should be able to clear a turret');
});

// --- authoring safety ------------------------------------------------------

test('a turret pointed at a weapon that cannot be fired is rejected at load', async () => {
  const bad = JSON.parse(JSON.stringify(BASE.content.deployables.rotisserie));
  bad.turret.weapon = 'wrench'; // melee, no projectile
  await assert.rejects(() => loadContent(async (path) => {
    if (path === 'deployables/rotisserie.json') return bad;
    return nodeReader(path);
  }), /has no projectile to fire/);
});

test('a repeating trap with no cooldown is rejected at load', async () => {
  // It would fire every single tick for as long as anyone stood near it.
  const bad = JSON.parse(JSON.stringify(BASE.content.deployables.wet_floor_sign));
  delete bad.trigger.cooldownSec;
  await assert.rejects(() => loadContent(async (path) => {
    if (path === 'deployables/wet_floor_sign.json') return bad;
    return nodeReader(path);
  }), /needs a cooldownSec or it fires every tick/);
});

test('a deploy weapon pointed at nothing is rejected at load', async () => {
  const bad = JSON.parse(JSON.stringify(BASE.content.weapons.grill));
  bad.deploy.deployable = 'trebuchet';
  await assert.rejects(() => loadContent(async (path) => {
    if (path === 'weapons/grill.json') return bad;
    return nodeReader(path);
  }), /deploys unknown deployable "trebuchet"/);
});

test('the snapshot carries deployables with their armed state', () => {
  const { world } = field();
  const item = deploy(world);
  let snap = world.snapshot().deployables;
  assert.equal(snap.length, 1);
  assert.equal(snap[0].defId, 'grill');
  assert.equal(snap[0].armed, false, 'freshly placed, still arming');

  run(world, 70);
  snap = world.snapshot().deployables;
  assert.equal(snap[0].armed, true, 'the renderer needs to show it is live');
  assert.equal(snap[0].id, item.id);
});
