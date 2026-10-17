/**
 * What a weapon actually does, derived from its JSON.
 *
 * A weapon is a dozen numbers and no two of them mean anything alone: 17
 * damage is unremarkable until you see it leaves the rifle at 560 rpm and
 * kills in 0.54 s. These are the numbers you balance against, computed the
 * same way the simulation computes them so the panel cannot flatter a weapon
 * the engine will disagree with.
 */

import { fireIntervalSec, perShotDamage } from '../engine/sim/weapons.js';

const TARGET_HEALTH = 100;

export { fireIntervalSec };

/** Damage scale at a distance, from the falloff block. */
export function falloffAt(weapon, distance) {
  const f = weapon.fire?.falloff;
  if (!f) return 1;
  const { startDistance = 0, endDistance = 1, minScale = 1 } = f;
  if (distance <= startDistance) return 1;
  if (distance >= endDistance) return minScale;
  const t = (distance - startDistance) / Math.max(0.0001, endDistance - startDistance);
  return 1 + (minScale - 1) * t;
}

export function statsFor(weapon) {
  const fire = weapon.fire ?? {};
  const pellets = fire.pellets ?? 1;
  // Through the simulation's own damage function, so a beam's rate and a
  // shotgun's pellets are both counted the way the engine counts them.
  const perShot = perShotDamage(weapon) * pellets;
  const interval = fireIntervalSec(weapon);

  // Shots to kill, and the time that takes. The first shot is instant, so a
  // 3-shot kill costs two intervals, not three — the classic off-by-one that
  // makes a weapon feel faster than its DPS suggests.
  const stk = perShot > 0 ? Math.ceil(TARGET_HEALTH / perShot) : Infinity;
  const ttk = Number.isFinite(stk) ? (stk - 1) * interval : Infinity;

  const headDamage = perShot * (fire.headshotMultiplier ?? 1);
  const headStk = headDamage > 0 ? Math.ceil(TARGET_HEALTH / headDamage) : Infinity;
  const headTtk = Number.isFinite(headStk) ? (headStk - 1) * interval : Infinity;

  const dps = interval > 0 && Number.isFinite(interval) ? perShot / interval : 0;

  // How long the magazine lasts if you hold the trigger down.
  const shots = (weapon.ammo?.start ?? 0) / (weapon.ammo?.perShot ?? 1);
  const sustain = Number.isFinite(interval) ? shots * interval : 0;

  const splash = weapon.splash
    ? { radius: weapon.splash.radius, max: weapon.splash.damage, min: weapon.splash.minDamage }
    : null;

  return {
    perShot,
    pellets,
    // A pellet weapon's damage is only real if every pellet lands, which at
    // anything past touching distance it does not. Reported so the panel
    // cannot quietly make shotguns look like snipers.
    allPelletsAssumed: pellets > 1,
    oneShot: stk === 1,
    dps,
    stk,
    ttk,
    headStk,
    headTtk,
    rpm: fire.rpm ?? 0,
    sustainSec: sustain,
    shots,
    splash,
    // Spread at a distance is what decides whether those numbers are real.
    coneAt: (dist) => Math.tan((fire.spreadDeg ?? 0) * Math.PI / 180) * dist * 2,
    adsConeAt: (dist) => Math.tan((fire.spreadDegAds ?? fire.spreadDeg ?? 0) * Math.PI / 180) * dist * 2,
    damageAt: (dist) => perShot * falloffAt(weapon, dist),
  };
}

/** Flag the combinations that make a weapon unusable or unfair. */
export function critique(weapon) {
  const notes = [];
  const s = statsFor(weapon);
  const fire = weapon.fire ?? {};
  // A beam's clock is its tickSec and a deployed trap's damage lives on the
  // thing it puts down, so neither is judged on rpm or on fire.damage. This
  // panel used to call every beam broken.
  const isBeam = fire.type === 'beam';
  const isDeploy = fire.type === 'deploy';

  if (!isBeam && !isDeploy && !(fire.rpm > 0)) {
    notes.push(['bad', 'rpm must be above zero or it never fires']);
  }
  if ((fire.damage ?? 0) < 0) notes.push(['bad', 'damage cannot be negative']);
  if (isBeam && !(fire.damagePerSec > 0)) {
    notes.push(['bad', 'a beam needs damagePerSec above zero']);
  }
  if (isBeam && !(fire.range > 0)) notes.push(['bad', 'a beam needs a range']);
  if (isDeploy && typeof weapon.deploy?.deployable !== 'string') {
    notes.push(['bad', 'a deploy weapon needs deploy.deployable']);
  }
  if (fire.type === 'melee' && !(fire.range > 0)) {
    notes.push(['bad', 'a melee weapon needs a range to reach with']);
  }
  if (fire.type === 'projectile' && !(weapon.projectile?.speed > 0)) {
    notes.push(['bad', 'a projectile weapon needs projectile.speed above zero']);
  }
  if (weapon.splash && weapon.splash.damage < weapon.splash.minDamage) {
    notes.push(['bad', 'splash.damage must be at least splash.minDamage']);
  }

  if (s.ttk < 0.12 && Number.isFinite(s.ttk)) notes.push(['warn', `kills in ${(s.ttk * 1000) | 0} ms — nobody will enjoy that`]);
  if (s.ttk > 2.2 && Number.isFinite(s.ttk)) notes.push(['warn', `takes ${s.ttk.toFixed(2)} s to kill, which is an age in this game`]);
  // A deploy weapon is not supposed to kill anything by itself; its trap does.
  if (!isDeploy && !Number.isFinite(s.stk)) {
    notes.push(['warn', 'cannot kill a full-health fighter at all']);
  }
  if (isBeam && Number.isFinite(s.ttk)) {
    const seconds = TARGET_HEALTH / Math.max(1, fire.damagePerSec);
    if (seconds > 3.5) notes.push(['warn', `${seconds.toFixed(1)} s of held beam to kill`]);
  }
  if (s.sustainSec < 1.5 && s.sustainSec > 0) notes.push(['warn', `only ${s.sustainSec.toFixed(1)} s of ammo`]);
  if ((fire.spreadDeg ?? 0) > 6) notes.push(['warn', `${fire.spreadDeg}° spread is nearly unaimable`]);
  if (weapon.splash && weapon.splash.selfDamageScale === 0) {
    notes.push(['warn', 'no self damage makes rocket jumping free']);
  }
  return notes;
}
