import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BASE, placeActor } from './helpers.mjs';
import { World } from '../src/engine/sim/World.js';
import { Bot } from '../src/engine/ai/Bot.js';
import { Rng } from '../src/engine/core/Rng.js';
import { distance } from '../src/engine/math/vec3.js';

function withBot(profileId, seed = 7, mutatorIds = []) {
  const world = new World({ ...BASE, mutatorIds, seed });
  const bot = world.addActor({
    id: 'bot', name: 'Bot', isBot: true, characterId: 'grunt',
    loadout: ['rifle', 'rocket_launcher'],
  });
  world.attachController('bot', new Bot({
    profile: BASE.content.bots[profileId], rng: new Rng(seed), name: 'Bot',
  }));
  return { world, bot };
}

test('a bot left alone patrols instead of standing still', () => {
  const { world, bot } = withBot('normal');
  placeActor(world, bot, -19, 0, 0);
  const start = { ...bot.position };

  let travelled = 0;
  let last = { ...bot.position };
  for (let i = 0; i < 600; i++) {
    world.step(1 / 60);
    travelled += distance(bot.position, last);
    last = { ...bot.position };
  }
  assert.ok(travelled > 20, `bot barely moved (${travelled.toFixed(1)}m in 10s)`);
  assert.ok(distance(bot.position, start) > 5, 'bot ended up where it started');
  assert.ok(bot.position.y > -25, 'bot walked off the map');
});

test('a bot holds fire until its reaction delay has elapsed', () => {
  const { world, bot } = withBot('easy', 3);
  const dummy = world.addActor({ id: 'dummy', name: 'Dummy', characterId: 'grunt', loadout: ['rifle'] });
  placeActor(world, bot, -19, 0, -8);
  placeActor(world, dummy, -19, 0, 8);
  bot.setLook(Math.PI, 0); // already staring straight at them

  let firstShotAt = null;
  world.events.on('fire', () => { firstShotAt ??= world.time; });
  for (let i = 0; i < 120; i++) world.step(1 / 60);

  assert.ok(firstShotAt !== null, 'the bot never shot at all');
  const minReaction = BASE.content.bots.easy.reactionTimeSec[0];
  assert.ok(firstShotAt >= minReaction,
    `bot fired after ${firstShotAt.toFixed(2)}s, under its ${minReaction}s reaction floor`);
});

test('aim error separates the difficulty profiles', () => {
  // Rifle only, so this measures aim rather than rocket luck. Averaged over
  // fixed seeds: a single run is far too noisy to assert on.
  const SEEDS = [11, 23, 31, 47, 59, 71];

  const dpsFor = (profileId) => {
    let total = 0;
    for (const seed of SEEDS) {
      const world = new World({ ...BASE, seed });
      const bot = world.addActor({
        id: 'bot', name: 'Bot', isBot: true, characterId: 'grunt', loadout: ['rifle'],
      });
      world.attachController('bot', new Bot({
        profile: BASE.content.bots[profileId], rng: new Rng(seed), name: 'Bot',
      }));
      const dummy = world.addActor({
        id: 'dummy', name: 'Dummy', characterId: 'grunt', loadout: ['rifle'],
      });
      placeActor(world, bot, -19, 0, -7);
      placeActor(world, dummy, -19, 0, 7);
      world.events.on('damage', (e) => { if (e.victim === 'dummy') total += e.amount; });
      world.setCommand('dummy', { forward: 0, strafe: 0, fire: false, yaw: 0, pitch: 0 });

      for (let i = 0; i < 900; i++) {
        dummy.health = 100; // keep the target up so we measure accuracy, not kills
        dummy.spawnProtectUntil = -1;
        world.step(1 / 60);
      }
    }
    return total / (SEEDS.length * 15);
  };

  const easy = dpsFor('easy');
  const normal = dpsFor('normal');
  const hard = dpsFor('hard');

  assert.ok(easy > 1, `an easy bot should still land something, got ${easy.toFixed(1)} dps`);
  assert.ok(normal > easy * 1.5, `normal (${normal.toFixed(1)}) should beat easy (${easy.toFixed(1)})`);
  assert.ok(hard > normal * 1.5, `hard (${hard.toFixed(1)}) should beat normal (${normal.toFixed(1)})`);
  assert.ok(hard < 60, `hard (${hard.toFixed(1)} dps) should still be beatable`);
});

test('bots do not shoot through the centre platform', () => {
  const { world, bot } = withBot('hard', 5);
  const dummy = world.addActor({ id: 'dummy', name: 'Dummy', characterId: 'grunt', loadout: ['rifle'] });
  // Pinned on opposite sides of the solid centre block.
  placeActor(world, bot, -20, 0, 0);
  placeActor(world, dummy, 20, 0, 0);
  bot.setLook(-Math.PI / 2, 0);

  let hits = 0;
  world.events.on('damage', (e) => { if (e.victim === 'dummy') hits++; });
  for (let i = 0; i < 90; i++) {
    // Hold both in place so neither can wander around the block.
    placeActor(world, bot, -20, 0, 0);
    placeActor(world, dummy, 20, 0, 0);
    world.step(1 / 60);
  }
  assert.equal(hits, 0, 'the bot shot through a solid wall');
});

test('bots prefer the rifle at knife range and rockets at distance', () => {
  const pick = (gap) => {
    const { world, bot } = withBot('normal', 9);
    const dummy = world.addActor({ id: 'dummy', name: 'Dummy', characterId: 'grunt', loadout: ['rifle'] });
    placeActor(world, bot, -19, 0, -gap / 2);
    placeActor(world, dummy, -19, 0, gap / 2);
    for (let i = 0; i < 30; i++) {
      placeActor(world, bot, -19, 0, -gap / 2);
      placeActor(world, dummy, -19, 0, gap / 2);
      world.step(1 / 60);
    }
    return bot.weaponId;
  };
  assert.equal(pick(4), 'rifle', 'rocketing your own feet is not a plan');
  assert.equal(pick(26), 'rocket_launcher');
});
