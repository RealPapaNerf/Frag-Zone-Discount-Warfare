import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BASE, placeActor } from './helpers.mjs';
import { World } from '../src/engine/sim/World.js';
import { applyDamage } from '../src/engine/sim/damage.js';

function arena(mutatorIds = []) {
  const world = new World({ ...BASE, mutatorIds });
  const a = world.addActor({ id: 'a', name: 'Ada', characterId: 'grunt', loadout: ['rifle'] });
  const b = world.addActor({ id: 'b', name: 'Bo', characterId: 'grunt', loadout: ['rifle'] });
  a.spawnProtectUntil = -1;
  b.spawnProtectUntil = -1;
  return { world, a, b };
}

test('a kill scores, counts and lands in the kill feed', () => {
  const { world, a, b } = arena();
  const feed = [];
  world.events.on('kill', (e) => feed.push(e));

  applyDamage(world, b, 500, { attacker: 'a', weapon: 'rifle', headshot: true });

  assert.equal(b.alive, false);
  assert.equal(a.kills, 1);
  assert.equal(a.score, 1);
  assert.equal(b.deaths, 1);
  assert.equal(feed.length, 1);
  assert.equal(feed[0].attackerName, 'Ada');
  assert.equal(feed[0].victimName, 'Bo');
  assert.equal(feed[0].headshot, true);
  assert.equal(world.match.killFeed.length, 1);
});

test('killing yourself costs a point instead of scoring one', () => {
  const { world, a } = arena();
  applyDamage(world, a, 500, { attacker: 'a', weapon: 'rocket_launcher', cause: 'self' });
  assert.equal(a.kills, 0);
  assert.equal(a.score, -1);
  assert.equal(a.deaths, 1);
});

test('the dead respawn after the mode delay, at full health', () => {
  const { world, a, b } = arena();
  applyDamage(world, b, 500, { attacker: 'a', weapon: 'rifle' });
  assert.equal(b.alive, false);

  const delay = world.rules.respawnDelaySec;
  for (let i = 0; i < Math.floor((delay - 0.1) * 60); i++) world.step(1 / 60);
  assert.equal(b.alive, false, 'respawned too early');

  for (let i = 0; i < 20; i++) world.step(1 / 60);
  assert.equal(b.alive, true, 'never respawned');
  assert.equal(b.health, world.rules.maxHealth);
  // `start` is the total carried, split between the magazine and the pouch.
  assert.equal(b.mag.rifle + b.ammo.rifle, world.content.weapons.rifle.ammo.start);
});

test('spawn protection briefly absorbs damage from others but not yourself', () => {
  const { world, a, b } = arena();
  applyDamage(world, b, 500, { attacker: 'a', weapon: 'rifle' });
  for (let i = 0; i < 180; i++) world.step(1 / 60);
  assert.equal(b.alive, true);

  b.spawnProtectUntil = world.time + 1;
  applyDamage(world, b, 40, { attacker: 'a', weapon: 'rifle' });
  assert.equal(b.health, 100, 'spawn protection should have absorbed that');

  applyDamage(world, b, 40, { attacker: 'b', weapon: 'rocket_launcher', cause: 'self' });
  assert.equal(b.health, 60, 'you can always hurt yourself');
});

test('reaching the score limit ends the match and names a winner', () => {
  const { world, a, b } = arena();
  const ended = [];
  world.events.on('matchEnd', (e) => ended.push(e));

  a.score = world.rules.scoreLimit - 1;
  applyDamage(world, b, 500, { attacker: 'a', weapon: 'rifle' });
  world.step(1 / 60);

  assert.equal(world.match.state, 'over');
  assert.equal(world.match.winnerId, 'a');
  assert.equal(ended.length, 1);
  assert.equal(ended[0].reason, 'scoreLimit');
  assert.equal(ended[0].standings[0].name, 'Ada');
});

test('nobody respawns once the match is over', () => {
  const { world, a, b } = arena();
  a.score = world.rules.scoreLimit;
  world.step(1 / 60);
  assert.equal(world.match.state, 'over');

  applyDamage(world, b, 500, { attacker: 'a', weapon: 'rifle' });
  for (let i = 0; i < 600; i++) world.step(1 / 60);
  assert.equal(b.alive, false, 'the match is over, stay down');
});

test('the scoreboard sorts by score then fewest deaths', () => {
  const { world, a, b } = arena();
  const c = world.addActor({ id: 'c', name: 'Cy', characterId: 'grunt', loadout: ['rifle'] });
  a.score = 5; a.deaths = 4;
  b.score = 5; b.deaths = 1;
  c.score = 9; c.deaths = 7;

  const names = world.match.standings().map((s) => s.name);
  assert.deepEqual(names, ['Cy', 'Bo', 'Ada']);
});

test('the snapshot carries everything a client needs to draw a frame', () => {
  const { world, a } = arena();
  placeActor(world, a, -19, 0, 0);
  world.step(1 / 60);
  const snap = world.snapshot();

  assert.equal(typeof snap.tick, 'number');
  assert.equal(snap.actors.length, 2);
  const mine = snap.actors.find((x) => x.id === 'a');
  assert.ok(mine.pos && typeof mine.yaw === 'number');
  assert.equal(mine.weapon, 'rifle');
  assert.ok(Array.isArray(snap.match.standings));
  assert.ok(Array.isArray(snap.projectiles));
  // Nothing in a snapshot may be a live object reference: it has to survive
  // a round trip through JSON for milestone 2.
  assert.deepEqual(JSON.parse(JSON.stringify(snap)), snap);
});
