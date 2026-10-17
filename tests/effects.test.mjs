import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BASE, placeActor, nodeReader } from './helpers.mjs';
import { World } from '../src/engine/sim/World.js';
import { loadContent } from '../src/data/Content.js';

/**
 * Status effects: the primitive a pile of the weapon list is blocked on. The
 * interesting cases are the ones where an effect has to outlive something —
 * a tick, a trade, or the person it is attached to.
 */

const hold = (extra = {}) => ({ forward: 0, strafe: 0, jump: false, fire: false, ...extra });
const run = (world, ticks) => { for (let i = 0; i < ticks; i++) world.step(1 / 60); };

function arena(ids = ['a', 'b'], loadout = ['rifle']) {
  const world = new World({ ...BASE, seed: 3 });
  const actors = {};
  ids.forEach((id, i) => {
    const actor = world.addActor({ id, name: id.toUpperCase(), characterId: 'grunt', loadout });
    placeActor(world, actor, -19, 0, -4 + i * 4);
    actor.spawnProtectUntil = -1;
    world.setCommand(id, hold({ yaw: 0, pitch: 0 }));
    actors[id] = actor;
  });
  return { world, ...actors };
}

// --- the shape of an effect ------------------------------------------------

test('an effect goes on, totals up its modifiers, and comes off when it expires', () => {
  const { world, a } = arena();
  const def = world.content.effects.pinned;

  assert.equal(world.applyEffect(a, 'pinned', { source: 'b' }), true);
  assert.equal(a.hasEffect('pinned'), true);
  assert.equal(a.mods.canMove, false);

  run(world, Math.ceil(def.durationSec * 60) + 4);
  assert.equal(a.hasEffect('pinned'), false, 'it should have run out');
  assert.equal(a.mods.canMove, true, 'and given the modifier back');
});

test('stacks compound scales, add up rates, and leave flags alone', () => {
  const { world, a } = arena();
  const slow = world.content.effects.bedazzled.modifiers.moveSpeedScale;

  world.applyEffect(a, 'bedazzled', { source: 'b' });
  assert.ok(Math.abs(a.mods.moveSpeedScale - slow) < 1e-9);
  world.applyEffect(a, 'bedazzled', { source: 'b' });
  world.applyEffect(a, 'bedazzled', { source: 'b' });
  assert.equal(a.effectStacks('bedazzled'), 3);
  assert.ok(Math.abs(a.mods.moveSpeedScale - slow ** 3) < 1e-9,
    'three stacks of a slow is the slow cubed');

  // A rate adds up instead.
  world.applyEffect(a, 'burning', { source: 'b' });
  world.applyEffect(a, 'burning', { source: 'b' });
  const dps = world.content.effects.burning.modifiers.damagePerSec;
  assert.equal(a.mods.damagePerSec, dps * 2);
});

test('stacks stop at the ceiling the effect declares', () => {
  const { world, a } = arena();
  const max = world.content.effects.burning.maxStacks;
  for (let i = 0; i < max + 5; i++) world.applyEffect(a, 'burning', { source: 'b' });
  assert.equal(a.effectStacks('burning'), max);
});

// --- the modifiers actually bite -------------------------------------------

test('being pinned takes the walking away but leaves the falling', () => {
  const { world, a } = arena();
  world.setCommand('a', hold({ forward: 1, yaw: 0, pitch: 0 }));
  run(world, 40);
  const freeRun = Math.abs(a.position.z + 4);
  assert.ok(freeRun > 3, `sanity: they should have moved, went ${freeRun.toFixed(1)}m`);

  world.applyEffect(a, 'pinned', { source: 'b' });
  const z = a.position.z;
  run(world, 40);
  assert.ok(Math.abs(a.position.z - z) < 1.5,
    'a pinned actor should skid to a stop, not keep running');

  // Still subject to gravity.
  a.position.y = 6;
  a.grounded = false;
  run(world, 20);
  assert.ok(a.position.y < 6, 'pinned is not floating');
});

test('a slow actually slows you down', () => {
  const plain = arena();
  plain.world.setCommand('a', hold({ forward: 1, yaw: 0, pitch: 0 }));
  run(plain.world, 90);
  const fast = Math.abs(plain.a.position.z + 4);

  const slowed = arena();
  for (let i = 0; i < 4; i++) slowed.world.applyEffect(slowed.a, 'bedazzled', { source: 'b' });
  slowed.world.setCommand('a', hold({ forward: 1, yaw: 0, pitch: 0 }));
  run(slowed.world, 90);
  const slow = Math.abs(slowed.a.position.z + 4);

  assert.ok(slow < fast * 0.95, `expected to cover less ground: ${slow.toFixed(1)} vs ${fast.toFixed(1)}`);
});

test('damage over time is banked rather than rounded away', () => {
  // 7 a second is 0.117 a tick, and applyDamage rounds. Paid per tick it
  // would round to nothing for ever, which is exactly what it did at first.
  const { world, a } = arena();
  const dps = world.content.effects.burning.modifiers.damagePerSec;
  world.applyEffect(a, 'burning', { source: 'b' });
  run(world, 180); // three seconds

  const taken = 100 - a.health;
  assert.ok(taken >= dps * 2.5 && taken <= dps * 3.5,
    `expected about ${dps * 3} damage over three seconds, got ${taken}`);
});

test('burning to death credits the person who lit you', () => {
  const { world, a, b } = arena();
  a.health = 6;
  let killedBy = null;
  let cause = null;
  world.events.on('kill', (e) => { killedBy = e.attacker; cause = e.cause; });
  world.applyEffect(a, 'burning', { source: b.id });
  // Just over a second: long enough for 7 a second to finish them, short
  // enough that the respawn timer has not put them back on their feet — the
  // first version of this test read `alive` after three seconds and found
  // them up again.
  run(world, 70);
  assert.ok(killedBy !== null, 'they should have burnt down');
  assert.equal(killedBy, 'b', 'the kill belongs to whoever set the fire');
  assert.equal(cause, 'burn');
});

// --- spreading -------------------------------------------------------------

test('fire jumps to whoever is standing too close', () => {
  const { world, a, b } = arena();
  placeActor(world, a, -19, 0, 0);
  placeActor(world, b, -19, 0, 1.4); // inside the spread radius
  world.applyEffect(a, 'burning', { source: 'c' });
  run(world, 90);
  assert.equal(b.hasEffect('burning'), true, 'they should have caught it');
});

test('fire does not reach someone standing clear of it', () => {
  const { world, a, b } = arena();
  const radius = world.content.effects.burning.spread.radiusM;
  placeActor(world, a, -19, 0, 0);
  placeActor(world, b, -19, 0, radius + 4);
  world.applyEffect(a, 'burning', { source: 'c' });
  run(world, 120);
  assert.equal(b.hasEffect('burning'), false);
});

test('catching fire off someone lights you but does not stack you', () => {
  // Two people stood together would otherwise push each other to maximum
  // stacks in seconds, and a crowd would be an instant death sentence.
  const { world, a, b } = arena();
  placeActor(world, a, -19, 0, 0);
  placeActor(world, b, -19, 0, 1.2);
  world.applyEffect(a, 'burning', { source: 'c' });
  run(world, 60 * 4);

  assert.equal(a.effectStacks('burning'), 1, 'the original should not have been re-stacked');
  assert.equal(b.effectStacks('burning'), 1, 'and neither should the one who caught it');
});

// --- death -----------------------------------------------------------------

test('death clears what it should and keeps what it should not', () => {
  const { world, a } = arena();
  world.applyEffect(a, 'burning', { source: 'b' });
  world.applyEffect(a, 'bedazzled', { source: 'b' });
  world.applyEffect(a, 'bedazzled', { source: 'b' });

  world.respawn(a);
  assert.equal(a.hasEffect('burning'), false, 'you do not respawn on fire');
  assert.equal(a.effectStacks('bedazzled'), 2, 'rhinestones are for life');
  assert.ok(a.mods.moveSpeedScale < 1, 'and they still slow you down');
  assert.equal(a.damageDebt, 0, 'no banked damage carries over');
});

// --- weapons apply them ----------------------------------------------------

test('a weapon applies its onHit effect to what it hits', () => {
  const world = new World({ ...BASE, seed: 3 });
  const a = world.addActor({ id: 'a', name: 'A', characterId: 'grunt', loadout: ['bedazzler'] });
  const b = world.addActor({ id: 'b', name: 'B', characterId: 'grunt', loadout: ['rifle'] });
  placeActor(world, a, -19, 0, -6);
  placeActor(world, b, -19, 0, 6);
  a.spawnProtectUntil = -1;
  b.spawnProtectUntil = -1;
  a.setLook(Math.PI, Math.atan2(0.9 - 1.6, 12));

  world.setCommand('a', hold({ fire: true, yaw: a.yaw, pitch: a.pitch }));
  run(world, 6);
  assert.ok(b.health < 100, 'sanity: it should have hit');
  assert.equal(b.hasEffect('bedazzled'), true, 'and applied what it carries');
  assert.equal(b.effects.get('bedazzled').source, 'a', 'credited to the shooter');
});

test('the blowtorch sets people alight', () => {
  const world = new World({ ...BASE, seed: 3 });
  const a = world.addActor({ id: 'a', name: 'A', characterId: 'grunt', loadout: ['blowtorch'] });
  const b = world.addActor({ id: 'b', name: 'B', characterId: 'grunt', loadout: ['rifle'] });
  placeActor(world, a, -19, 0, -2);
  placeActor(world, b, -19, 0, 2);
  a.spawnProtectUntil = -1;
  b.spawnProtectUntil = -1;
  a.setLook(Math.PI, Math.atan2(0.9 - 1.6, 4));

  world.setCommand('a', hold({ fire: true, yaw: a.yaw, pitch: a.pitch }));
  run(world, 20);
  assert.equal(b.hasEffect('burning'), true);
});

test('the snapshot carries effects so the renderer can show them', () => {
  const { world, a } = arena();
  world.applyEffect(a, 'bedazzled', { source: 'b' });
  world.applyEffect(a, 'bedazzled', { source: 'b' });
  const snap = world.snapshot().actors.find((x) => x.id === 'a');
  assert.deepEqual(snap.effects.map((e) => ({ id: e.id, stacks: e.stacks })),
    [{ id: 'bedazzled', stacks: 2 }]);
});

test('effects announce themselves so the HUD and renderer can react', () => {
  const { world, a } = arena();
  const seen = [];
  world.events.on('effectStart', (e) => seen.push(['start', e.effect]));
  world.events.on('effectStack', (e) => seen.push(['stack', e.effect, e.stacks]));
  world.events.on('effectEnd', (e) => seen.push(['end', e.effect]));

  world.applyEffect(a, 'pinned', { source: 'b' });
  world.applyEffect(a, 'bedazzled', { source: 'b' });
  world.applyEffect(a, 'bedazzled', { source: 'b' });
  run(world, 60 * 4);

  assert.deepEqual(seen, [
    ['start', 'pinned'],
    ['start', 'bedazzled'],
    ['stack', 'bedazzled', 2],
    ['end', 'pinned'],
  ]);
});

// --- authoring safety ------------------------------------------------------

test('a weapon pointing at an effect that does not exist is rejected at load', async () => {
  const weapon = JSON.parse(JSON.stringify(BASE.content.weapons.rifle));
  weapon.onHit = [{ effect: 'enchanted', chance: 1 }];
  await assert.rejects(() => loadContent(async (path) => {
    if (path === 'weapons/rifle.json') return weapon;
    return nodeReader(path);
  }), /onHit references unknown effect "enchanted"/);
});

test('a permanent effect that also burns you is rejected at load', async () => {
  // It would never expire and never stop, which is never what anyone meant.
  const bad = JSON.parse(JSON.stringify(BASE.content.effects.bedazzled));
  bad.modifiers.damagePerSec = 4;
  await assert.rejects(() => loadContent(async (path) => {
    if (path === 'effects/bedazzled.json') return bad;
    return nodeReader(path);
  }), /permanent effect cannot deal damage over time/);
});

test('applying an effect that was never loaded does nothing rather than throwing', () => {
  const { world, a } = arena();
  assert.equal(world.applyEffect(a, 'enchanted', { source: 'b' }), false);
  assert.equal(a.effects.size, 0);
});
