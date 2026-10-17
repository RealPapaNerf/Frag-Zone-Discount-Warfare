import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BASE, placeActor } from './helpers.mjs';
import { World } from '../src/engine/sim/World.js';
import { chargeLevel, maxChargeDamageScale, clampClaimDamage } from '../src/engine/sim/weapons.js';

/**
 * Burst and charge both make the trigger mean something other than "one shot
 * now", so these tests mostly count shots and watch the clock.
 */

const hold = (extra = {}) => ({ forward: 0, strafe: 0, jump: false, fire: false, ...extra });

function duel(loadout, gap = 12) {
  const world = new World({ ...BASE });
  const shooter = world.addActor({ id: 'a', name: 'A', characterId: 'grunt', loadout });
  const target = world.addActor({ id: 'b', name: 'B', characterId: 'grunt', loadout: ['rifle'] });
  const LANE_X = -19;
  placeActor(world, shooter, LANE_X, 0, -gap / 2);
  placeActor(world, target, LANE_X, 0, gap / 2);
  shooter.spawnProtectUntil = -1;
  target.spawnProtectUntil = -1;
  shooter.setLook(Math.PI, Math.atan2(0.89 - 1.6, gap));
  return { world, shooter, target };
}

const command = (world, extra) =>
  world.setCommand('a', hold({ yaw: Math.PI, pitch: -0.059, ...extra }));

const run = (world, ticks) => { for (let i = 0; i < ticks; i++) world.step(1 / 60); };

function countShots(world) {
  let shots = 0;
  world.events.on('fire', () => { shots += 1; });
  return () => shots;
}

// --- burst -----------------------------------------------------------------

test('one pull of a burst trigger fires the whole burst', () => {
  const { world, shooter } = duel(['burst_rifle']);
  const spec = world.content.weapons.burst_rifle.fire.burst;
  const shots = countShots(world);

  command(world, { fire: true });
  world.step(1 / 60);
  assert.equal(shots(), 1, 'the first round goes immediately');

  // Let go straight away — the rest of the burst is owed regardless.
  command(world, { fire: false });
  run(world, Math.ceil(spec.intervalSec * spec.count * 60) + 2);
  assert.equal(shots(), spec.count, 'the burst finishes after the trigger is released');
  assert.equal(shooter.burst, null);
});

test('a burst fires faster than the weapon rpm and then waits out its cooldown', () => {
  const { world } = duel(['burst_rifle']);
  const weapon = world.content.weapons.burst_rifle;
  const spec = weapon.fire.burst;
  const shots = countShots(world);

  // Hold the trigger down: a semi-automatic burst needs a release between
  // bursts, so this must produce exactly one burst however long we hold.
  command(world, { fire: true });
  run(world, 60);
  assert.equal(shots(), spec.count, `expected one burst of ${spec.count}, got ${shots()}`);

  // A fresh pull after the cooldown gives another burst.
  command(world, { fire: false });
  run(world, 6);
  command(world, { fire: true });
  run(world, 30);
  assert.equal(shots(), spec.count * 2);
});

test('the burst interval is what the weapon says it is', () => {
  const { world } = duel(['burst_rifle']);
  const spec = world.content.weapons.burst_rifle.fire.burst;
  const at = [];
  world.events.on('fire', () => at.push(world.time));

  command(world, { fire: true });
  run(world, 40);
  assert.equal(at.length, spec.count);
  for (let i = 1; i < at.length; i++) {
    const gap = at[i] - at[i - 1];
    assert.ok(Math.abs(gap - spec.intervalSec) <= 1 / 60 + 1e-9,
      `gap ${i} was ${gap.toFixed(4)}s, wanted ${spec.intervalSec}s`);
  }
});

test('a burst stops rather than firing rounds the magazine does not have', () => {
  const { world, shooter } = duel(['burst_rifle']);
  const shots = countShots(world);
  shooter.mag.burst_rifle = 2; // one short of a full burst
  shooter.ammo.burst_rifle = 0;

  command(world, { fire: true });
  run(world, 40);
  assert.equal(shots(), 2, 'it should fire what it had and stop');
  assert.equal(shooter.mag.burst_rifle, 0);
  assert.equal(shooter.burst, null);
});

test('switching weapons abandons a burst in progress', () => {
  const { world, shooter } = duel(['burst_rifle', 'rifle']);
  const shots = countShots(world);
  command(world, { fire: true });
  world.step(1 / 60);
  assert.equal(shots(), 1);

  command(world, { fire: false, weaponSlot: 1 });
  run(world, 30);
  assert.equal(shooter.burst, null, 'the burst belongs to the weapon that started it');
  assert.equal(shots(), 1, 'no owed rounds should come out of the other weapon');
});

// --- charge ----------------------------------------------------------------

test('a charge weapon does not fire while the trigger is held', () => {
  const { world, shooter } = duel(['railgun']);
  const shots = countShots(world);
  command(world, { fire: true });
  run(world, 40);
  assert.equal(shots(), 0, 'holding winds up, it does not shoot');
  assert.ok(shooter.charge > 0.5, `expected a charge to build, got ${shooter.charge}`);
});

test('releasing a charge fires once, and the charge resets', () => {
  const { world, shooter } = duel(['railgun']);
  const shots = countShots(world);
  command(world, { fire: true });
  run(world, 40);
  command(world, { fire: false });
  world.step(1 / 60);

  assert.equal(shots(), 1);
  assert.equal(shooter.charge, 0);
  assert.equal(shooter.chargeSince, null);
});

test('letting go before the minimum throws the charge away without firing', () => {
  const { world, shooter } = duel(['railgun']);
  const spec = world.content.weapons.railgun.fire.charge;
  const shots = countShots(world);
  let aborted = 0;
  world.events.on('chargeAbort', () => { aborted += 1; });

  command(world, { fire: true });
  run(world, Math.max(1, Math.floor(spec.minSec * 60) - 2));
  command(world, { fire: false });
  world.step(1 / 60);

  assert.equal(shots(), 0, 'a flinch should not fire a railgun');
  assert.equal(aborted, 1);
  assert.equal(shooter.charge, 0);
});

test('a fuller charge hurts more', () => {
  const damageAt = (ticks) => {
    const { world, target } = duel(['railgun']);
    command(world, { fire: true });
    run(world, ticks);
    command(world, { fire: false });
    world.step(1 / 60);
    return 100 - target.health;
  };

  const tapped = damageAt(14);  // just past minSec
  const full = damageAt(70);    // past maxSec
  assert.ok(tapped > 0, 'a minimum-length charge should still do something');
  assert.ok(full > tapped * 2, `full charge ${full} should dwarf a tap ${tapped}`);
});

test('charge scaling reaches the ends of the range the weapon declares', () => {
  const weapon = BASE.content.weapons.railgun;
  const spec = weapon.fire.charge;
  assert.equal(chargeLevel(weapon, 0), 0);
  assert.equal(chargeLevel(weapon, spec.maxSec), 1);
  assert.equal(chargeLevel(weapon, spec.maxSec * 10), 1, 'charge cannot overfill');
  assert.equal(maxChargeDamageScale(weapon), Math.max(...spec.damageScale));
  assert.equal(maxChargeDamageScale(BASE.content.weapons.rifle), 1,
    'a weapon with no charge block scales by one');
});

test('the damage clamp lets a fully charged shot through', () => {
  // The clamp exists to stop a bad claim deleting someone. It must not also
  // ceiling a legitimately charged shot back down to a tap.
  const weapon = BASE.content.weapons.railgun;
  const rules = { damageScale: 1 };
  const full = weapon.fire.damage * Math.max(...weapon.fire.charge.damageScale);
  const allowed = clampClaimDamage({ damage: full }, weapon, rules);
  assert.ok(Math.abs(allowed - full) < 0.01, `a full charge of ${full} was clamped to ${allowed}`);

  const absurd = clampClaimDamage({ damage: 99999 }, weapon, rules);
  assert.ok(absurd < full * 1.6, 'but an invented number is still ceilinged');
});

test('a charge weapon still has to reload', () => {
  const { world, shooter } = duel(['railgun']);
  shooter.mag.railgun = 1;
  command(world, { fire: true });
  run(world, 70);
  command(world, { fire: false });
  world.step(1 / 60);
  assert.equal(shooter.mag.railgun, 0);
  assert.ok(shooter.reload, 'the last round should have started a reload');

  // And a charge cannot be built while that reload runs.
  command(world, { fire: true });
  run(world, 30);
  assert.equal(shooter.charge, 0, 'no winding up mid-reload');
});
