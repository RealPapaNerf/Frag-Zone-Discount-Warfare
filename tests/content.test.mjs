import { test } from 'node:test';
import assert from 'node:assert/strict';
import { content } from './helpers.mjs';
import { buildRuleSet, applyPatches, DEFAULT_RULES } from '../src/engine/rules/RuleSet.js';

test('every manifest document loads and validates', () => {
  assert.ok(content.maps.blockout_arena);
  assert.ok(content.weapons.rifle);
  assert.ok(content.weapons.rocket_launcher);
  assert.ok(content.characters.grunt);
  assert.equal(Object.keys(content.bots).length, 3);
});

test('rocket launcher carries splash and knockback data', () => {
  const rocket = content.weapons.rocket_launcher;
  assert.equal(rocket.fire.type, 'projectile');
  assert.ok(rocket.splash.radius > 0);
  assert.ok(rocket.splash.selfKnockbackScale >= rocket.splash.selfDamageScale,
    'rocket jumping needs full knockback with reduced self damage');
});

test('mutators stack as ordered patches', () => {
  const rules = buildRuleSet(content.modes.deathmatch, [
    content.mutators.low_gravity,
    content.mutators.big_heads,
  ]);
  assert.ok(Math.abs(rules.gravityScale - 0.42) < 1e-9);
  assert.equal(rules.headScale, 2.6);
  assert.equal(rules.scoreLimit, 25, 'mode rules survive mutator stacking');
});

test('stacking is order dependent and multiplicative', () => {
  const twice = buildRuleSet(content.modes.deathmatch, [
    content.mutators.low_gravity,
    content.mutators.low_gravity,
  ]);
  assert.ok(Math.abs(twice.gravityScale - 0.42 * 0.42) < 1e-9);
});

test('instagib forces a loadout and infinite ammo', () => {
  const rules = buildRuleSet(content.modes.deathmatch, [content.mutators.instagib]);
  assert.deepEqual(rules.forcedLoadout, ['rifle']);
  assert.equal(rules.infiniteAmmo, true);
  assert.equal(rules.damageScale, 20);
});

test('an unknown rule path is rejected rather than silently ignored', () => {
  assert.throws(
    () => applyPatches({ ...DEFAULT_RULES }, [{ path: 'gravtyScale', op: 'mul', value: 2 }]),
    /unknown rule "gravtyScale"/,
  );
});
