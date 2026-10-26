import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BASE, nodeReader } from './helpers.mjs';
import { loadContent } from '../src/data/Content.js';
import { World } from '../src/engine/sim/World.js';
import { Rng } from '../src/engine/core/Rng.js';
import { pickBotLoadout } from '../src/engine/ai/loadout.js';
import { weaponIdsForMode } from '../src/engine/rules/weaponPool.js';

/**
 * Normal play gets normal weapons; each themed mode gets its own shelf and
 * nothing else. The joke builds that used to stand in for the arena guns
 * live on in the themed shelves, with the mechanics they always had.
 */

const { content } = BASE;
const THEMED = {
  as_seen_on_tv: 'tv',
  construction_zone: 'construction',
  bargain_bin: 'office',
};

test('each themed mode offers its own shelf and nothing else', () => {
  for (const [modeId, category] of Object.entries(THEMED)) {
    const ids = weaponIdsForMode(content, content.modes[modeId]);
    assert.ok(ids.length >= 5, `${modeId} should have a real roster`);
    for (const id of ids) {
      assert.equal(content.weapons[id].category, category, `${id} is in ${modeId}`);
    }
  }
  const tv = weaponIdsForMode(content, content.modes.as_seen_on_tv);
  assert.ok(tv.includes('slap_chop'));
  for (const gun of ['rifle', 'shotgun', 'railgun', 'rocket_launcher']) {
    assert.ok(!tv.includes(gun), `${gun} should not be in As Seen On TV`);
  }
});

test('the joke builds moved to the themed shelves with their mechanics intact', () => {
  const moved = {
    doorbell: 'shotgun', telescope: 'railgun', hairdryer: 'beam', plunger: 'sticky_bomb',
    rivetgun: 'burst_rifle', wheelbarrow: 'grenade_launcher', persuader: 'wrench',
  };
  for (const [joke, arena] of Object.entries(moved)) {
    const a = content.weapons[arena];
    const j = content.weapons[joke];
    assert.ok(j, `${joke} exists`);
    assert.notEqual(j.category, 'arena', `${joke} is on a themed shelf`);
    assert.equal(a.category, 'arena', `${arena} stays in the arena set`);
    assert.deepEqual(j.fire, a.fire, `${joke} fires like the ${arena} it was`);
    assert.deepEqual(j.ammo, a.ammo, `${joke} feeds like the ${arena} it was`);
  }
});

test('bots in a themed mode never turn up with something the mode forbids', () => {
  const rng = new Rng(99);
  for (const modeId of Object.keys(THEMED)) {
    const mode = content.modes[modeId];
    const allowed = weaponIdsForMode(content, mode);
    const seen = new Set();
    for (let i = 0; i < 300; i++) {
      for (const id of pickBotLoadout(content, rng, mode)) {
        assert.ok(allowed.includes(id), `a ${modeId} bot drew "${id}"`);
        seen.add(id);
      }
    }
    assert.ok(seen.has(mode.botAllRounder), `${modeId} bots mostly carry its all-rounder`);
  }
});

test('the bot fallback stays inside the mode even with no all-rounder anywhere', () => {
  const bare = {
    ...content,
    manifest: { ...content.manifest, defaults: { ...content.manifest.defaults, botLoadout: {} } },
  };
  const mode = { ...content.modes.as_seen_on_tv, botAllRounder: undefined };
  const [id] = pickBotLoadout(bare, new Rng(1), mode);
  assert.equal(content.weapons[id].category, 'tv',
    `fell back to "${id}" rather than the first weapon in the manifest`);
});

test("a map's weapon pickups are skipped in a mode without that weapon", () => {
  const weaponSpawners = (modeId) => new World({ ...BASE, mapId: 'garden', modeId })
    .pickups.spawners.filter((s) => s.def.weaponId).map((s) => s.def.weaponId);

  const dm = weaponSpawners('deathmatch');
  assert.ok(dm.includes('shotgun') && dm.includes('railgun'), 'the garden stocks arena guns');
  assert.deepEqual(weaponSpawners('as_seen_on_tv'), [],
    'no shotgun plinth, and no rifle ammo, in an infomercial match');

  const health = new World({ ...BASE, mapId: 'garden', modeId: 'as_seen_on_tv' })
    .pickups.spawners.filter((s) => s.def.kind === 'health');
  assert.equal(health.length, 2, 'health is not a weapon and stays');
});

test('a mode whose bot all-rounder it does not allow is rejected at load', async () => {
  const mode = JSON.parse(JSON.stringify(content.modes.as_seen_on_tv));
  mode.botAllRounder = 'rifle';
  await assert.rejects(() => loadContent(async (path) => {
    if (path === 'modes/as_seen_on_tv.json') return mode;
    return nodeReader(path);
  }), /bot all-rounder "rifle" is not a weapon this mode allows/);
});

test('a mode whose opening loadout it does not allow is rejected at load', async () => {
  const mode = JSON.parse(JSON.stringify(content.modes.construction_zone));
  mode.defaultLoadout = ['nailgun', 'slap_chop'];
  await assert.rejects(() => loadContent(async (path) => {
    if (path === 'modes/construction_zone.json') return mode;
    return nodeReader(path);
  }), /default loadout weapon "slap_chop" is not a weapon this mode allows/);
});
