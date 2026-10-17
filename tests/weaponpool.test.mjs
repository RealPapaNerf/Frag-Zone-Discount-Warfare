import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BASE, nodeReader } from './helpers.mjs';
import { loadContent } from '../src/data/Content.js';
import { Rng } from '../src/engine/core/Rng.js';
import { pickBotLoadout } from '../src/engine/ai/loadout.js';
import {
  weaponAllowed, weaponsForMode, weaponIdsForMode, categoriesForMode,
} from '../src/engine/rules/weaponPool.js';

/**
 * Which weapons a mode will let you carry. The joke weapons belong to the
 * modes they were written for; a normal match gets the arena set.
 */

const JOKES = ['slap_chop', 'ped_egg', 'thighmaster', 'chainsaw', 'hole_punch', 'grill'];

test('a normal mode offers the arena set and nothing else', () => {
  const deathmatch = BASE.content.modes.deathmatch;
  assert.deepEqual(categoriesForMode(deathmatch), ['arena']);

  const ids = weaponIdsForMode(BASE.content, deathmatch);
  assert.ok(ids.length > 5, 'there should still be a real roster');
  for (const joke of JOKES) {
    assert.ok(!ids.includes(joke), `${joke} should not be in deathmatch`);
  }
  for (const id of ids) {
    assert.equal(BASE.content.weapons[id].category, 'arena');
  }
});

test('the chaos mode offers everything', () => {
  const ids = weaponIdsForMode(BASE.content, BASE.content.modes.patch_notes);
  for (const joke of JOKES) {
    assert.ok(ids.includes(joke), `${joke} should be available in patch notes`);
  }
  assert.ok(ids.includes('rifle'), 'and the arena set too');
});

test('a mode naming no categories gets the lot', () => {
  const ids = weaponIdsForMode(BASE.content, { id: 'anything' });
  const visible = Object.values(BASE.content.weapons).filter((w) => !w.hidden);
  assert.equal(ids.length, visible.length, 'no restriction means no restriction');
});

test('hidden weapons are never offered, whatever the mode', () => {
  const chicken = BASE.content.weapons.rotisserie_chicken;
  assert.equal(chicken.hidden, true);
  assert.equal(weaponAllowed(chicken, null), false);
  assert.equal(weaponAllowed(chicken, BASE.content.modes.patch_notes), false);
});

test('every visible weapon has a category the manifest declares', () => {
  const known = Object.keys(BASE.content.manifest.weaponCategories);
  assert.ok(known.includes('arena'));
  for (const weapon of Object.values(BASE.content.weapons)) {
    if (weapon.hidden) continue;
    assert.ok(known.includes(weapon.category),
      `${weapon.id} has category "${weapon.category}"`);
  }
});

test('every mode has somebody able to bring a weapon to it', () => {
  for (const mode of Object.values(BASE.content.modes)) {
    assert.ok(weaponsForMode(BASE.content, mode).length > 0, `${mode.id} is unplayable`);
  }
});

test('bots draw from the same shelves the lobby offers', () => {
  // A deathmatch bot turning up with a Ped Egg would be the same bug as the
  // lobby offering one.
  const rng = new Rng(4242);
  const deathmatch = BASE.content.modes.deathmatch;
  const allowed = weaponIdsForMode(BASE.content, deathmatch);

  for (let i = 0; i < 400; i++) {
    for (const id of pickBotLoadout(BASE.content, rng, deathmatch)) {
      assert.ok(allowed.includes(id), `bot drew "${id}", which deathmatch does not allow`);
    }
  }
});

test('bots in the chaos mode can draw the joke weapons', () => {
  const rng = new Rng(7);
  const mode = BASE.content.modes.patch_notes;
  const seen = new Set();
  for (let i = 0; i < 800; i++) {
    for (const id of pickBotLoadout(BASE.content, rng, mode)) seen.add(id);
  }
  assert.ok([...seen].some((id) => BASE.content.weapons[id].category !== 'arena'),
    'over 800 draws a specialist from a themed shelf should turn up');
});

test('the default loadout is legal in the default mode', () => {
  const d = BASE.content.manifest.defaults;
  const mode = BASE.content.modes[d.mode];
  for (const id of d.loadout) {
    assert.ok(weaponAllowed(BASE.content.weapons[id], mode),
      `the lobby opens with "${id}" ticked, which ${d.mode} does not allow`);
  }
});

// --- authoring safety ------------------------------------------------------

test('a weapon in a category the manifest never declared is rejected at load', async () => {
  const weapon = JSON.parse(JSON.stringify(BASE.content.weapons.rifle));
  weapon.category = 'kitchenware';
  await assert.rejects(() => loadContent(async (path) => {
    if (path === 'weapons/rifle.json') return weapon;
    return nodeReader(path);
  }), /category "kitchenware" is not one of/);
});

test('a mode drawing from a category that does not exist is rejected at load', async () => {
  const mode = JSON.parse(JSON.stringify(BASE.content.modes.deathmatch));
  mode.weaponCategories = ['arena', 'cutlery'];
  await assert.rejects(() => loadContent(async (path) => {
    if (path === 'modes/deathmatch.json') return mode;
    return nodeReader(path);
  }), /unknown weapon category "cutlery"/);
});

test('a mode nobody can bring a weapon to is rejected at load', async () => {
  const mode = JSON.parse(JSON.stringify(BASE.content.modes.deathmatch));
  mode.weaponCategories = ['office'];
  // Its default loadout is arena, so this also proves the two checks are
  // separate: the mode is playable, the lobby's opening ticks are not legal.
  await assert.rejects(() => loadContent(async (path) => {
    if (path === 'modes/deathmatch.json') return mode;
    return nodeReader(path);
  }), /not available in mode "deathmatch"/);
});
