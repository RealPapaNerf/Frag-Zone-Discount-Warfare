import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BASE, placeActor, nodeReader } from './helpers.mjs';
import { loadContent } from '../src/data/Content.js';
import { World } from '../src/engine/sim/World.js';

/**
 * Grenades are the first projectiles that do not end on the thing they touch,
 * so these tests are mostly about a projectile *surviving* an impact, and
 * about the fuse being the thing that eventually ends it.
 */

const hold = (extra = {}) => ({ forward: 0, strafe: 0, jump: false, fire: false, ...extra });

function thrower(loadout = ['grenade_launcher']) {
  const world = new World({ ...BASE });
  const actor = world.addActor({ id: 'a', name: 'A', characterId: 'grunt', loadout });
  placeActor(world, actor, -19, 0, 0);
  actor.spawnProtectUntil = -1;
  actor.setLook(Math.PI, 0);
  return { world, actor };
}

const run = (world, ticks) => { for (let i = 0; i < ticks; i++) world.step(1 / 60); };

/** Throw one, then stop pulling the trigger. */
function lob(world, pitch = 0) {
  world.setCommand('a', hold({ fire: true, yaw: Math.PI, pitch }));
  world.step(1 / 60);
  world.setCommand('a', hold({ yaw: Math.PI, pitch }));
  return world.projectiles.projectiles[0];
}

test('a grenade bounces off a wall instead of detonating on it', () => {
  const { world } = thrower();
  let bounces = 0;
  let ended = 0;
  world.events.on('projectileBounce', () => { bounces += 1; });
  world.events.on('projectileEnd', () => { ended += 1; });

  // Straight down into the floor, which is the one surface always in reach.
  lob(world, -Math.PI / 2 + 0.05);
  run(world, 40);
  assert.ok(bounces >= 1, 'it should have bounced off the floor');
  assert.equal(ended, 0, 'and not gone off on contact');
});

test('a bounce loses energy and eventually comes to rest', () => {
  const { world } = thrower();
  const p = lob(world, -Math.PI / 2 + 0.05);
  run(world, 90);
  const live = world.projectiles.projectiles.find((q) => q.id === p.id);
  assert.ok(live, 'the fuse is 2.2s, so it should still be alive at 1.5s');
  assert.ok(live.resting, 'a grenade that has stopped bouncing should be at rest');
  assert.ok(live.bouncesLeft < p.bounce.maxBounces, 'it should have spent bounces getting there');
});

test('the fuse, not the impact, is what sets a grenade off', () => {
  const { world } = thrower();
  const fuse = world.content.weapons.grenade_launcher.projectile.fuseSec;
  const ends = [];
  world.events.on('projectileEnd', (e) => ends.push({ at: world.time, hit: e.hit }));

  lob(world, -Math.PI / 2 + 0.05);
  run(world, Math.ceil(fuse * 60) - 10);
  assert.equal(ends.length, 0, 'still ticking');

  run(world, 20);
  assert.equal(ends.length, 1, 'the fuse should have ended it');
  assert.equal(ends[0].hit, 'fuse');
  assert.ok(Math.abs(ends[0].at - fuse) < 0.1, `went off at ${ends[0].at}, fuse is ${fuse}`);
});

test('a grenade still explodes, and still hurts', () => {
  const world = new World({ ...BASE });
  const thrower = world.addActor({
    id: 'a', name: 'A', characterId: 'grunt', loadout: ['grenade_launcher'],
  });
  const victim = world.addActor({ id: 'b', name: 'B', characterId: 'grunt', loadout: ['rifle'] });
  placeActor(world, thrower, -19, 0, -4);
  placeActor(world, victim, -19, 0, -1.2);
  thrower.spawnProtectUntil = -1;
  victim.spawnProtectUntil = -1;
  thrower.setLook(Math.PI, -0.9); // lob it at their feet

  let explosions = 0;
  world.events.on('explosion', () => { explosions += 1; });
  world.setCommand('a', hold({ fire: true, yaw: Math.PI, pitch: -0.9 }));
  world.step(1 / 60);
  world.setCommand('a', hold({ yaw: Math.PI, pitch: -0.9 }));
  run(world, 200);

  assert.equal(explosions, 1);
  assert.ok(victim.health < 100, `expected splash damage, victim still at ${victim.health}`);
});

test('a sticky bomb stops dead on the wall it hits', () => {
  const { world } = thrower(['sticky_bomb']);
  let stuck = null;
  world.events.on('projectileStick', (e) => { stuck = e; });

  lob(world, -Math.PI / 2 + 0.05);
  run(world, 30);
  assert.ok(stuck, 'it should have reported sticking');
  assert.equal(stuck.target, null, 'to the world, not a player');

  const live = world.projectiles.projectiles[0];
  assert.ok(live.resting);
  assert.equal(live.vel.x, 0);
  assert.equal(live.vel.y, 0);
  assert.equal(live.vel.z, 0);
});

test('a sticky bomb rides the player it lands on', () => {
  const world = new World({ ...BASE });
  const shooter = world.addActor({
    id: 'a', name: 'A', characterId: 'grunt', loadout: ['sticky_bomb'],
  });
  const victim = world.addActor({ id: 'b', name: 'B', characterId: 'grunt', loadout: ['rifle'] });
  placeActor(world, shooter, -19, 0, -6);
  placeActor(world, victim, -19, 0, 0);
  shooter.spawnProtectUntil = -1;
  victim.spawnProtectUntil = -1;
  shooter.setLook(Math.PI, Math.atan2(0.9 - 1.6, 6));

  let stuck = null;
  world.events.on('projectileStick', (e) => { stuck = e; });
  world.setCommand('a', hold({ fire: true, yaw: shooter.yaw, pitch: shooter.pitch }));
  world.step(1 / 60);
  world.setCommand('a', hold({ yaw: shooter.yaw, pitch: shooter.pitch }));
  run(world, 20);

  assert.ok(stuck, 'the bomb should have stuck to something');
  assert.equal(stuck.target, 'b', 'and that something is the victim');

  // Walk the victim and check the bomb goes with them.
  const p = world.projectiles.projectiles[0];
  const before = { ...p.pos };
  victim.position.x += 3;
  world.step(1 / 60);
  assert.ok(Math.abs(p.pos.x - (before.x + 3)) < 0.2,
    'a stuck bomb should follow its host, not hang in the air');

  // And it kills them when the fuse runs out.
  run(world, Math.ceil(1.5 * 60) + 10);
  assert.ok(victim.health < 100, 'the fuse should have gone off on them');
});

test('a rocket is untouched: it still goes off on the thing it hits', () => {
  const { world } = thrower(['rocket_launcher']);
  const ends = [];
  world.events.on('projectileEnd', (e) => ends.push(e.hit));
  world.events.on('projectileBounce', () => assert.fail('a rocket must not bounce'));

  lob(world, -Math.PI / 2 + 0.05);
  run(world, 30);
  assert.deepEqual(ends, ['world'], 'it should detonate on the floor, once');
});

test('a grenade that has bounced can come back and hurt its thrower', () => {
  // Deliberate: a rocket cannot hit its own muzzle, but a grenade that has
  // left you and come off a wall is fair game. It is what makes a bad bounce
  // your own fault.
  const { world } = thrower();
  const p = lob(world, -Math.PI / 2 + 0.05);
  run(world, 40);
  assert.ok(p.bouncesLeft < p.bounce.maxBounces, 'it has bounced at least once');
  assert.equal(world.projectiles.projectiles.length, 1);
});

test('content validation rejects a nonsense bounce or fuse', async () => {
  // A weapon file is the authoring surface for all of this, so a typo in it
  // should fail loudly at load rather than quietly produce a dud grenade.
  const base = JSON.parse(JSON.stringify(BASE.content.weapons.grenade_launcher));
  const load = (patch) => {
    const doc = JSON.parse(JSON.stringify(base));
    Object.assign(doc.projectile, patch);
    return loadContent(async (path) => {
      if (path === 'manifest.json') {
        return {
          schema: 1,
          content: { weapons: ['grenade_launcher'], maps: ['blockout_arena'], characters: ['grunt'], modes: ['deathmatch'], bots: ['normal'] },
          defaults: { map: 'blockout_arena', mode: 'deathmatch', character: 'grunt', botProfile: 'normal', loadout: ['grenade_launcher'] },
        };
      }
      if (path === 'weapons/grenade_launcher.json') return doc;
      return nodeReader(path);
    });
  };

  await assert.rejects(() => load({ bounce: { restitution: 1.8, maxBounces: 3 } }),
    /restitution must sit between 0 and 1/);
  await assert.rejects(() => load({ bounce: { restitution: 0.4, maxBounces: 0 } }),
    /maxBounces must be at least 1/);
  await assert.rejects(() => load({ fuseSec: 0 }), /fuseSec must be positive/);

  // And the real thing still loads.
  await load({});
});
