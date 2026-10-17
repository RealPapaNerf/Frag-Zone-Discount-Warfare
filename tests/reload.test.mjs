import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BASE, placeActor } from './helpers.mjs';
import { World } from '../src/engine/sim/World.js';
import { Bot } from '../src/engine/ai/Bot.js';
import { Rng } from '../src/engine/core/Rng.js';

/**
 * Reloading is the one mechanic that can stop a weapon firing for a reason
 * other than being out of ammo, so most of these tests are about *when the
 * trigger does nothing* — the part a player notices.
 */

const hold = (extra = {}) => ({ forward: 0, strafe: 0, jump: false, fire: false, ...extra });

function lone(loadout = ['rifle'], mutatorIds = []) {
  const world = new World({ ...BASE, mutatorIds });
  const actor = world.addActor({ id: 'a', name: 'A', characterId: 'grunt', loadout });
  placeActor(world, actor, -19, 0, 0);
  actor.spawnProtectUntil = -1;
  actor.setLook(Math.PI, 0);
  return { world, actor };
}

const fireFor = (world, ticks, extra = {}) => {
  world.setCommand('a', hold({ fire: true, yaw: Math.PI, pitch: 0, ...extra }));
  for (let i = 0; i < ticks; i++) world.step(1 / 60);
};

/** Ask for a reload, and spend the one tick it takes for the ask to land. */
const requestReload = (world) => {
  world.setCommand('a', hold({ reload: true, yaw: Math.PI, pitch: 0 }));
  world.step(1 / 60);
};

/** Let go of everything, then let time pass. */
const waitFor = (world, seconds) => {
  world.setCommand('a', hold({ yaw: Math.PI, pitch: 0 }));
  for (let i = 0; i < Math.ceil(seconds * 60); i++) world.step(1 / 60);
};

test('a magazine is filled out of the rounds carried, not on top of them', () => {
  const { actor, world } = lone();
  const spec = world.content.weapons.rifle.ammo;
  assert.equal(actor.mag.rifle, spec.magazine);
  assert.equal(actor.ammo.rifle, spec.start - spec.magazine);
  assert.equal(actor.mag.rifle + actor.ammo.rifle, spec.start,
    'the gun cannot spawn with more rounds than it says it carries');
});

test('firing empties the magazine and leaves the pouch alone', () => {
  const { world, actor } = lone();
  fireFor(world, 12);
  assert.ok(actor.mag.rifle < 30, 'the magazine should be going down');
  assert.equal(actor.ammo.rifle, 130, 'the pouch only moves when a reload lands');
});

test('firing dry starts a reload on its own, and the pouch refills the magazine', () => {
  const { world, actor } = lone();
  // 30 rounds at 560 rpm is a little over three seconds of trigger.
  fireFor(world, 60 * 4);
  assert.equal(actor.mag.rifle, 0, 'the magazine should be empty by now');
  assert.ok(actor.reload, 'running dry should have started a reload unprompted');

  // Let go before waiting it out, or the reload lands and the still-held
  // trigger immediately starts spending the fresh magazine.
  waitFor(world, 2);
  assert.equal(actor.mag.rifle, 30, 'the reload should have seated a full magazine');
  assert.equal(actor.ammo.rifle, 100, '30 rounds should have come out of the pouch');
  assert.equal(actor.reload, null);
});

test('the trigger does nothing while a magazine reload is running', () => {
  const { world, actor } = lone();
  actor.mag.rifle = 4;
  world.setCommand('a', hold({ reload: true, yaw: Math.PI, pitch: 0 }));
  world.step(1 / 60);
  assert.ok(actor.reload, 'the reload should have started');

  const before = actor.mag.rifle;
  fireFor(world, 30); // half a second of trigger, mid-reload
  assert.equal(actor.mag.rifle, before, 'no round should have left the magazine');
});

test('switching weapons abandons the reload and loads nothing', () => {
  const { world, actor } = lone(['rifle', 'rocket_launcher']);
  actor.mag.rifle = 2;
  world.setCommand('a', hold({ reload: true, yaw: Math.PI, pitch: 0 }));
  world.step(1 / 60);
  assert.ok(actor.reload);

  world.setCommand('a', hold({ weaponSlot: 1, yaw: Math.PI, pitch: 0 }));
  world.step(1 / 60);
  assert.equal(actor.reload, null, 'putting the gun away cancels the reload');
  assert.equal(actor.mag.rifle, 2, 'a reload that never finished loads nothing');
  assert.equal(actor.ammo.rifle, 130);
});

test('a reload is declined when the magazine is full or the pouch is empty', () => {
  const { world, actor } = lone();
  world.setCommand('a', hold({ reload: true, yaw: Math.PI, pitch: 0 }));
  world.step(1 / 60);
  assert.equal(actor.reload, null, 'a full magazine has nothing to reload');

  actor.mag.rifle = 1;
  actor.ammo.rifle = 0;
  world.setCommand('a', hold({ reload: true, yaw: Math.PI, pitch: 0 }));
  world.step(1 / 60);
  assert.equal(actor.reload, null, 'an empty pouch has nothing to reload from');
});

test('a single-round reload feeds one shell at a time', () => {
  const { world, actor } = lone(['shotgun']);
  const step = world.content.weapons.shotgun.ammo.reloadSec;
  actor.mag.shotgun = 0;
  const reserve = actor.ammo.shotgun;

  // A tick of slack on each wait: the reload starts a tick after the command
  // arrives, so landing exactly on `step` is a coin flip.
  requestReload(world);
  waitFor(world, step + 1 / 30);
  assert.equal(actor.mag.shotgun, 1, 'one shell per step, not the whole tube');
  assert.equal(actor.ammo.shotgun, reserve - 1);
  assert.ok(actor.reload, 'it should still be feeding');

  waitFor(world, step * 2);
  assert.equal(actor.mag.shotgun, 3, 'three shells after three steps');
});

test('a single-round reload stops the moment you pull the trigger, keeping what it loaded', () => {
  const { world, actor } = lone(['shotgun']);
  const step = world.content.weapons.shotgun.ammo.reloadSec;
  actor.mag.shotgun = 0;

  requestReload(world);
  waitFor(world, step * 2 + 1 / 30);
  assert.equal(actor.mag.shotgun, 2, 'two shells in the tube');

  // The trigger interrupts the reload and fires one of the two shells it got.
  fireFor(world, 2);
  assert.equal(actor.reload, null, 'the trigger abandons a shell-by-shell reload');
  assert.equal(actor.mag.shotgun, 1, 'it fired one of the two shells already loaded');
});

test('a single-round reload stops once the tube is full', () => {
  const { world, actor } = lone(['shotgun']);
  const size = world.content.weapons.shotgun.ammo.magazine;
  actor.mag.shotgun = 0;
  world.setCommand('a', hold({ reload: true, yaw: Math.PI, pitch: 0 }));
  for (let i = 0; i < 60 * 10; i++) world.step(1 / 60);
  assert.equal(actor.mag.shotgun, size);
  assert.equal(actor.reload, null, 'it should stop rather than keep feeding a full tube');
});

test('infinite ammo skips magazines and reloads entirely', () => {
  // Instagib forces the rifle and infinite ammo; the rifle now has a magazine,
  // and the mutator has to keep meaning what it meant before it did.
  const { world, actor } = lone(['rifle'], ['instagib']);
  fireFor(world, 60 * 6);
  assert.equal(actor.reload, null, 'infinite ammo should never make you reload');
  assert.equal(actor.ammo.rifle, world.content.weapons.rifle.ammo.start - 30,
    'the pouch should be untouched by firing');
});

test('reloading announces itself so the HUD and the view model can react', () => {
  const { world, actor } = lone();
  const seen = [];
  world.events.on('reloadStart', (e) => seen.push(['start', e.weapon, e.style]));
  world.events.on('reloadEnd', (e) => seen.push(['end', e.weapon, e.loaded, e.done]));

  actor.mag.rifle = 0;
  world.setCommand('a', hold({ reload: true, yaw: Math.PI, pitch: 0 }));
  for (let i = 0; i < 60 * 3; i++) world.step(1 / 60);

  assert.deepEqual(seen, [
    ['start', 'rifle', 'magazine'],
    ['end', 'rifle', 30, true],
  ]);
});

test('the snapshot carries the magazine and the reload window', () => {
  const { world, actor } = lone();
  actor.mag.rifle = 3;
  world.setCommand('a', hold({ reload: true, yaw: Math.PI, pitch: 0 }));
  world.step(1 / 60);

  const me = world.snapshot().actors.find((a) => a.id === 'a');
  assert.equal(me.mag, 3);
  assert.equal(me.ammo, 130);
  assert.equal(me.reloading, true);
  assert.ok(me.reloadEndsAt > me.reloadFrom, 'the HUD needs both ends to draw a bar');
});

test('a bot reloads when its magazine runs out', () => {
  const world = new World({ ...BASE, seed: 7 });
  const bot = world.addActor({
    id: 'bot', name: 'Bot', isBot: true, characterId: 'grunt', loadout: ['rifle'],
  });
  world.attachController('bot', new Bot({
    profile: BASE.content.bots.hard, rng: new Rng(7), name: 'Bot',
  }));
  const dummy = world.addActor({ id: 'd', name: 'D', characterId: 'grunt', loadout: ['rifle'] });
  placeActor(world, bot, -19, 0, -7);
  placeActor(world, dummy, -19, 0, 7);
  world.setCommand('d', hold());

  let reloaded = 0;
  world.events.on('reloadEnd', (e) => { if (e.id === 'bot' && e.done) reloaded += 1; });
  for (let i = 0; i < 60 * 20; i++) {
    dummy.health = 100; // keep the target up so the bot keeps shooting
    dummy.spawnProtectUntil = -1;
    world.step(1 / 60);
  }
  assert.ok(reloaded >= 1, `a bot emptying a magazine should reload, got ${reloaded}`);
  assert.ok(bot.mag.rifle + bot.ammo.rifle < 160, 'and should have spent rounds doing it');
});
