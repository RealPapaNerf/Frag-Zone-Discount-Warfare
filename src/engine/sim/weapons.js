import { v3, set, normalize, cross, dirFromAngles, clamp } from '../math/vec3.js';
import { traceShot } from './trace.js';

/**
 * Firing is resolved on the shooter's machine and produces *claims*. In single
 * player the host applies them immediately; over the network a client will send
 * the same claims and the host will trust them, which is the "favour the
 * shooter" rule the project is built around. The host still clamps damage to
 * what the weapon JSON allows, because a bug is more likely than a cheater.
 */

const DEG = Math.PI / 180;

export function fireIntervalSec(weapon) {
  return 60 / Math.max(1, weapon.fire.rpm);
}

/** Rounds in the pouch. For a magazine weapon this excludes the loaded mag. */
export function ammoFor(actor, weaponId) {
  return actor.ammo[weaponId] ?? 0;
}

export const RELOAD_SINGLE = 'single';

export function magazineSize(weapon) {
  return weapon.ammo?.magazine ?? 0;
}

/**
 * A weapon without `ammo.magazine` has no magazine at all and draws straight
 * from the pouch, which is how every weapon behaved before reloading existed.
 */
export function hasMagazine(weapon) {
  return magazineSize(weapon) > 0;
}

/** What the trigger can actually spend right now. */
export function loadedFor(actor, weapon) {
  return hasMagazine(weapon) ? (actor.mag[weapon.id] ?? 0) : ammoFor(actor, weapon.id);
}

/**
 * `magazine` swaps the whole magazine in one go; `single` feeds one round at a
 * time, which is what makes a pump shotgun a pump shotgun — see the trigger
 * interrupt in World.
 */
export function reloadStyle(weapon) {
  return weapon.ammo?.reloadStyle === RELOAD_SINGLE ? RELOAD_SINGLE : 'magazine';
}

/** Seconds for one reload step: the whole magazine, or one round. */
export function reloadStepSec(weapon) {
  return Math.max(0.05, weapon.ammo?.reloadSec ?? 2);
}

export function isReloading(actor, weapon) {
  return actor.reload?.weaponId === weapon.id;
}

/**
 * Enough rounds for one shot, ignoring the rate limiter. A burst pays out
 * faster than the weapon's own rpm, so it checks this rather than canFire.
 */
export function hasRoundsFor(actor, weapon, rules) {
  if (rules.infiniteAmmo) return true;
  const need = weapon.ammo?.perShot ?? 1;
  if (hasMagazine(weapon)) {
    if (isReloading(actor, weapon)) return false;
    return (actor.mag[weapon.id] ?? 0) >= need;
  }
  return ammoFor(actor, weapon.id) >= need;
}

export function canFire(actor, weapon, time, rules) {
  if (!actor.alive) return false;
  if ((actor.nextFireAt[weapon.id] ?? 0) > time) return false;
  // Infinite ammo means exactly that: no pouch to check and no reload to wait
  // out. It is why instagib still plays the way it always did.
  if (rules.infiniteAmmo) return true;
  return hasRoundsFor(actor, weapon, rules);
}

// --- fire modes ------------------------------------------------------------

export function burstSpec(weapon) {
  return weapon.fire?.burst ?? null;
}

export function chargeSpec(weapon) {
  return weapon.fire?.charge ?? null;
}

export function burstCount(weapon) {
  return Math.max(1, Math.round(burstSpec(weapon)?.count ?? 1));
}

export function burstIntervalSec(weapon) {
  return Math.max(1 / 240, burstSpec(weapon)?.intervalSec ?? 0.06);
}

/** The pause after a whole burst, defaulting to the weapon's own rpm. */
export function burstCooldownSec(weapon) {
  return burstSpec(weapon)?.cooldownSec ?? fireIntervalSec(weapon);
}

/** How far a hold has charged, 0..1. */
export function chargeLevel(weapon, heldSec) {
  const spec = chargeSpec(weapon);
  if (!spec) return 0;
  return clamp(heldSec / Math.max(1e-6, spec.maxSec ?? 1), 0, 1);
}

/**
 * Charge specs are written as `[atRest, atFull]` pairs so a weapon can say
 * that charging *tightens* its spread while it raises its damage.
 */
export function chargeScale(pair, t, fallback = 1) {
  if (!Array.isArray(pair) || pair.length < 2) return fallback;
  return pair[0] + (pair[1] - pair[0]) * t;
}

/**
 * The most a charge can multiply damage. The host's damage clamp has to know
 * this or it would ceiling every charged shot back down to a tap.
 */
export function maxChargeDamageScale(weapon) {
  const spec = chargeSpec(weapon);
  if (!spec || !Array.isArray(spec.damageScale)) return 1;
  return Math.max(1, spec.damageScale[0], spec.damageScale[1]);
}

/**
 * Begin a reload.
 * @returns {boolean} whether one actually started — a full magazine, an empty
 *   pouch or a reload already running all decline.
 */
export function startReload(actor, weapon, time, rules) {
  if (!actor.alive || rules.infiniteAmmo || !hasMagazine(weapon)) return false;
  if (isReloading(actor, weapon)) return false;
  if ((actor.mag[weapon.id] ?? 0) >= magazineSize(weapon)) return false;
  if (ammoFor(actor, weapon.id) <= 0) return false;
  actor.reload = {
    weaponId: weapon.id,
    style: reloadStyle(weapon),
    startedAt: time,
    endsAt: time + reloadStepSec(weapon),
  };
  return true;
}

/**
 * Advance a reload that is already running. Rounds move from the pouch into
 * the magazine only when a step completes, so a reload interrupted half way
 * through loads nothing — except in `single` style, where every round that
 * already landed stays in the gun.
 *
 * @returns {number} rounds loaded by this call
 */
export function stepReload(actor, weapon, time) {
  const r = actor.reload;
  if (!r || r.weaponId !== weapon.id || time < r.endsAt) return 0;

  const size = magazineSize(weapon);
  const mag = actor.mag[weapon.id] ?? 0;
  const reserve = ammoFor(actor, weapon.id);
  if (mag >= size || reserve <= 0) {
    actor.reload = null;
    return 0;
  }

  if (r.style === RELOAD_SINGLE) {
    actor.mag[weapon.id] = mag + 1;
    actor.ammo[weapon.id] = reserve - 1;
    if (actor.mag[weapon.id] >= size || actor.ammo[weapon.id] <= 0) actor.reload = null;
    else {
      r.startedAt = time;
      r.endsAt = time + reloadStepSec(weapon);
    }
    return 1;
  }

  const moved = Math.min(size - mag, reserve);
  actor.mag[weapon.id] = mag + moved;
  actor.ammo[weapon.id] = reserve - moved;
  actor.reload = null;
  return moved;
}

/**
 * Load every weapon in a loadout to spawn state. `ammo.start` is the total
 * number of rounds carried, and the magazine is filled out of it rather than
 * on top of it, so a weapon cannot spawn with more than it says it does.
 */
export function resetAmmo(actor, weapons) {
  for (const weapon of weapons) {
    const pool = weapon.ammo?.start ?? 0;
    const loaded = Math.min(magazineSize(weapon), pool);
    actor.mag[weapon.id] = loaded;
    actor.ammo[weapon.id] = pool - loaded;
    actor.nextFireAt[weapon.id] = 0;
  }
  actor.reload = null;
}

/** Build an orthonormal basis around a forward direction for spread offsets. */
function basis(dir) {
  const up = Math.abs(dir.y) > 0.99 ? v3(0, 0, 1) : v3(0, 1, 0);
  const right = normalize(v3(), cross(v3(), dir, up));
  const trueUp = cross(v3(), right, dir);
  return { right, up: trueUp };
}

function spreadDir(dir, spreadDeg, rng) {
  if (spreadDeg <= 0) return { x: dir.x, y: dir.y, z: dir.z };
  const { right, up } = basis(dir);
  const off = rng.coneOffset(spreadDeg * DEG);
  return normalize(v3(), {
    x: dir.x + right.x * off.x + up.x * off.y,
    y: dir.y + right.y * off.x + up.y * off.y,
    z: dir.z + right.z * off.x + up.z * off.y,
  });
}

function falloffScale(fire, distance) {
  const f = fire.falloff;
  if (!f) return 1;
  if (distance <= f.startDistance) return 1;
  if (distance >= f.endDistance) return f.minScale;
  const t = (distance - f.startDistance) / (f.endDistance - f.startDistance);
  return 1 + (f.minScale - 1) * t;
}

/** Offset a muzzle point from the eye using the weapon's view offset. */
export function muzzlePoint(actor, weapon, dir, out = v3()) {
  const eye = actor.eye(out);
  const { right, up } = basis(dir);
  const off = weapon.projectile?.spawnOffset ?? [0, 0, -0.4];
  set(out,
    eye.x + right.x * off[0] + up.x * off[1] + dir.x * -off[2],
    eye.y + right.y * off[0] + up.y * off[1] + dir.y * -off[2],
    eye.z + right.z * off[0] + up.z * off[1] + dir.z * -off[2]);
  return out;
}

/**
 * Resolve a trigger pull.
 * @returns {{claims: object[], spawns: object[]}} claims are hit reports the
 *   host should apply; spawns are projectiles the host should simulate.
 */
export function fireWeapon(ctx, actor, weapon, aimDir = null, { charge = 0 } = {}) {
  const { arena, actors, rules, rng, time } = ctx;
  // A weapon with no charge block ignores the charge it was handed.
  const cspec = chargeSpec(weapon);
  const t = cspec ? clamp(charge, 0, 1) : 0;
  const damageScale = cspec ? chargeScale(cspec.damageScale, t) : 1;
  const spreadMul = cspec ? chargeScale(cspec.spreadScale, t) : 1;
  const dir = aimDir ? normalize(v3(), aimDir) : actor.viewDir(v3());
  const origin = actor.eye(v3());

  actor.nextFireAt[weapon.id] = time + fireIntervalSec(weapon);
  if (!rules.infiniteAmmo) {
    const spend = weapon.ammo?.perShot ?? 1;
    if (hasMagazine(weapon)) {
      actor.mag[weapon.id] = Math.max(0, (actor.mag[weapon.id] ?? 0) - spend);
    } else {
      actor.ammo[weapon.id] = Math.max(0, ammoFor(actor, weapon.id) - spend);
    }
  }

  const claims = [];
  const spawns = [];
  const fire = weapon.fire;

  if (fire.type === 'projectile') {
    const muzzle = muzzlePoint(actor, weapon, dir, v3());
    // Nudge the spawn point back inside the world if the barrel clips a wall.
    const toMuzzle = { x: muzzle.x - origin.x, y: muzzle.y - origin.y, z: muzzle.z - origin.z };
    const blocked = arena.raycast(origin, normalize(v3(), toMuzzle), Math.hypot(toMuzzle.x, toMuzzle.y, toMuzzle.z));
    spawns.push({
      kind: 'projectile',
      owner: actor.id,
      weaponId: weapon.id,
      origin: blocked ? origin : muzzle,
      dir: spreadDir(dir, (fire.spreadDeg ?? 0) * spreadMul, rng),
      // The host simulates the projectile, so the charge has to travel with
      // the spawn rather than being reapplied when it lands.
      speedScale: cspec ? chargeScale(cspec.speedScale, t) : 1,
      damageScale,
    });
  } else {
    const moving = Math.hypot(actor.velocity.x, actor.velocity.z) > 1.5;
    const hip = moving ? (fire.spreadDegMoving ?? fire.spreadDeg ?? 0) : (fire.spreadDeg ?? 0);
    // Sights are what a weapon's accuracy is really for, so aiming overrides
    // the moving penalty rather than stacking with it. A weapon with no
    // spreadDegAds simply does not reward aiming.
    const spread = (actor.aiming ? (fire.spreadDegAds ?? hip) : hip) * spreadMul;
    for (let i = 0; i < (fire.pellets ?? 1); i++) {
      const pelletDir = spreadDir(dir, spread, rng);
      const hit = traceShot(arena, actors, origin, pelletDir, fire.range ?? 300, actor.id);
      const claim = {
        kind: 'hitscan',
        shooter: actor.id,
        weaponId: weapon.id,
        origin: { ...origin },
        dir: pelletDir,
        point: hit.point,
        normal: hit.normal ?? null,
        target: hit.kind === 'actor' ? hit.actor.id : null,
        headshot: hit.kind === 'actor' ? hit.headshot && rules.headshots : false,
        distance: hit.t,
        surface: hit.kind === 'world' ? hit.brush.material : null,
      };
      if (claim.target !== null) {
        const base = fire.damage * falloffScale(fire, hit.t) * damageScale;
        claim.damage = base * (claim.headshot ? (fire.headshotMultiplier ?? 1) : 1);
      }
      claims.push(claim);
    }
  }

  return { claims, spawns };
}

/**
 * Host-side sanity clamp. Not anti-cheat — it keeps a bad claim from one-shot
 * deleting a player if a weapon file or a client build goes wrong.
 */
export function clampClaimDamage(claim, weapon, rules) {
  const fire = weapon.fire;
  const ceiling = fire.damage * (fire.headshotMultiplier ?? 1)
    * maxChargeDamageScale(weapon) * 1.01;
  return clamp((claim.damage ?? 0) * rules.damageScale, 0, ceiling * rules.damageScale);
}

export { dirFromAngles };
