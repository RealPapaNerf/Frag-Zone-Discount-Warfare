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

export function ammoFor(actor, weaponId) {
  return actor.ammo[weaponId] ?? 0;
}

export function canFire(actor, weapon, time, rules) {
  if (!actor.alive) return false;
  if ((actor.nextFireAt[weapon.id] ?? 0) > time) return false;
  if (!rules.infiniteAmmo && ammoFor(actor, weapon.id) < (weapon.ammo?.perShot ?? 1)) return false;
  return true;
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
export function fireWeapon(ctx, actor, weapon, aimDir = null) {
  const { arena, actors, rules, rng, time } = ctx;
  const dir = aimDir ? normalize(v3(), aimDir) : actor.viewDir(v3());
  const origin = actor.eye(v3());

  actor.nextFireAt[weapon.id] = time + fireIntervalSec(weapon);
  if (!rules.infiniteAmmo) {
    actor.ammo[weapon.id] = Math.max(0, ammoFor(actor, weapon.id) - (weapon.ammo?.perShot ?? 1));
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
      dir: spreadDir(dir, fire.spreadDeg ?? 0, rng),
    });
  } else {
    const moving = Math.hypot(actor.velocity.x, actor.velocity.z) > 1.5;
    const spread = moving ? (fire.spreadDegMoving ?? fire.spreadDeg ?? 0) : (fire.spreadDeg ?? 0);
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
        const base = fire.damage * falloffScale(fire, hit.t);
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
  const ceiling = fire.damage * (fire.headshotMultiplier ?? 1) * 1.01;
  return clamp((claim.damage ?? 0) * rules.damageScale, 0, ceiling * rules.damageScale);
}

export { dirFromAngles };
