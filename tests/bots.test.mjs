import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BASE, placeActor } from './helpers.mjs';
import { World } from '../src/engine/sim/World.js';
import { Bot } from '../src/engine/ai/Bot.js';
import { pickBotLoadout } from '../src/engine/ai/loadout.js';
import { Rng } from '../src/engine/core/Rng.js';
import { distance } from '../src/engine/math/vec3.js';
import { NavGraph } from '../src/engine/ai/NavGraph.js';

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

test('standing on an unreachable goal does not recurse the patrol forever', () => {
  // The freeze: the bot is parked on top of the only path #repath can deal —
  // its goal is the last place it saw someone, which is sticky, so finishing
  // the path and asking again hands back the same finished path. The old
  // #patrolMove recursed through that hand-off and blew the stack mid-match.
  const { world, bot } = withBot('normal');
  placeActor(world, bot, -19, 0, 0);

  // Two nodes with no edge between them, both within arrival distance of the
  // bot, so every dealt path is already finished: nearest(bot) is one node,
  // nearest(lastKnownPos) the other, and findPath between them fails.
  world.nav = new NavGraph({ nodes: [
    { id: 'under', pos: [-19.5, 0, 0] },
    { id: 'goal', pos: [-18.5, 0, 0] },
  ] }, world.arena);

  const controller = world.controllers.get('bot');
  controller.lastKnownPos = { x: -18.4, y: 0, z: 0 }; // nearest is 'goal'
  controller.targetLastSeenAt = world.time;           // fresh enough to chase
  controller.path = null;

  for (let i = 0; i < 120; i++) world.step(1 / 60); // throws on the old code

  assert.equal(controller.lastKnownPos, null,
    'arriving at the last-known spot should clear it');
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

  const raggedy = dpsFor('raggedy_anne');
  const smurf = dpsFor('smurf');
  const easy = dpsFor('easy');
  const normal = dpsFor('normal');
  const hard = dpsFor('hard');

  // The bottom two exist to be beaten by someone who has never held a mouse,
  // so the ladder is asserted all the way down: each level clearly worse than
  // the one above, and raggedy anne nearly harmless even at point blank.
  assert.ok(raggedy < 3, `raggedy anne should be nearly harmless, got ${raggedy.toFixed(1)} dps`);
  assert.ok(raggedy < smurf * 0.6, `raggedy anne (${raggedy.toFixed(1)}) should be well under smurf (${smurf.toFixed(1)})`);
  assert.ok(smurf < easy * 0.85, `smurf (${smurf.toFixed(1)}) should be clearly under easy (${easy.toFixed(1)})`);
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

test('bots almost always carry the all-rounder, and never an empty loadout', () => {
  // The scorer in Bot.#chooseWeapon can barely tell a shotgun from a sniper,
  // so the loadout is what keeps bots sensible: nearly all of them carry the
  // weapon that is never wrong at any range.
  const rng = new Rng(2024);
  const draws = Array.from({ length: 2000 }, () => pickBotLoadout(BASE.content, rng));

  for (const loadout of draws) {
    assert.ok(loadout.length >= 1, 'a bot must spawn holding something');
    for (const id of loadout) {
      assert.ok(BASE.content.weapons[id], `loadout referenced a missing weapon "${id}"`);
    }
  }

  const specialists = draws.filter((l) => !l.includes('rifle')).length;
  const share = specialists / draws.length;
  const want = BASE.content.manifest.defaults.botLoadout.specialistChance;
  assert.ok(Math.abs(share - want) < 0.03,
    `expected about ${want} specialists, got ${share.toFixed(3)}`);

  // A specialist carries only its specialty, so there is no choice for the
  // weapon scorer to get wrong.
  for (const loadout of draws.filter((l) => !l.includes('rifle'))) {
    assert.equal(loadout.length, 1, 'a specialist should carry one weapon');
  }
});

test('a bot loadout survives a manifest with no botLoadout block', () => {
  const stripped = {
    ...BASE.content,
    manifest: { ...BASE.content.manifest, defaults: { ...BASE.content.manifest.defaults } },
  };
  delete stripped.manifest.defaults.botLoadout;
  const loadout = pickBotLoadout(stripped, new Rng(5));
  assert.equal(loadout.length, 1);
  assert.ok(stripped.weapons[loadout[0]], 'it should fall back to a real weapon');
});
