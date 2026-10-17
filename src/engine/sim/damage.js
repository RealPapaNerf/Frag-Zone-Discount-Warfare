import { v3, set, sub, normalize, length, clamp } from '../math/vec3.js';
import { closestPoint } from '../math/aabb.js';
import { applyImpulse } from './movement.js';

/**
 * Damage application and radial (splash) damage. Both go through the host so
 * score, death and the kill feed have a single owner.
 */

/** @returns {{killed: boolean, applied: number}} */
export function applyDamage(world, victim, amount, meta) {
  if (!victim.alive || amount <= 0) return { killed: false, applied: 0 };
  if (world.time < victim.spawnProtectUntil && meta.attacker !== victim.id) {
    return { killed: false, applied: 0 };
  }

  const rules = world.rules;
  const attacker = meta.attacker != null ? world.actorById(meta.attacker) : null;
  const selfInflicted = attacker != null && attacker.id === victim.id;

  // "Only last place can deal damage". Ties count as last, so a fresh match
  // where everyone is on nothing is not a stalemate. Hurting yourself is
  // always allowed — being in first place should not make you immune to your
  // own rocket.
  if (rules.lastPlaceOnlyDamage && attacker && !selfInflicted) {
    const lowest = Math.min(...world.actors.map((a) => a.score));
    if (attacker.score > lowest) return { killed: false, applied: 0 };
  }

  if (!selfInflicted && attacker && rules.teams && !rules.friendlyFire && attacker.team === victim.team) {
    return { killed: false, applied: 0 };
  }
  if (selfInflicted && !rules.selfDamage) return { killed: false, applied: 0 };

  const applied = Math.min(victim.health, Math.round(amount));
  victim.health -= applied;
  victim.lastAttacker = selfInflicted ? victim.lastAttacker : (attacker?.id ?? null);
  victim.lastDamageAt = world.time;

  world.events.emit('damage', {
    victim: victim.id,
    attacker: meta.attacker ?? null,
    amount: applied,
    weapon: meta.weapon ?? null,
    headshot: !!meta.headshot,
    backstab: !!meta.backstab,
    point: meta.point ?? null,
    remaining: victim.health,
  });

  if (victim.health <= 0) {
    world.killActor(victim, {
      attacker: meta.attacker ?? null,
      weapon: meta.weapon ?? null,
      headshot: !!meta.headshot,
      cause: meta.cause ?? (selfInflicted ? 'self' : 'weapon'),
    });
    return { killed: true, applied };
  }
  return { killed: false, applied };
}

const tmpCenter = v3();
const tmpBox = { min: v3(), max: v3() };
const tmpDir = v3();

/**
 * Radial damage with linear falloff, line-of-sight occlusion, and knockback.
 * Self-knockback is kept at full strength while self-damage is scaled down,
 * which is exactly what makes rocket jumping worth doing.
 */
export function explode(world, { point, weapon, owner, cause = 'splash', damageScale = 1 }) {
  const splash = weapon.splash;
  if (!splash) return [];

  const rules = world.rules;
  const results = [];

  for (const actor of world.actors) {
    if (!actor.alive) continue;
    actor.box(tmpBox);
    const near = closestPoint(tmpBox, point);
    const dist = Math.hypot(near.x - point.x, near.y - point.y, near.z - point.z);
    if (dist > splash.radius) continue;

    actor.center(tmpCenter);
    // Walls block the blast. The check is centre-to-centre, so standing behind
    // cover works but peeking a corner still hurts.
    if (!world.arena.lineOfSight(point, tmpCenter)) continue;

    const falloff = 1 - clamp(dist / splash.radius, 0, 1);
    const isSelf = owner != null && actor.id === owner;

    const baseDamage = (splash.minDamage + (splash.damage - splash.minDamage) * falloff)
      * damageScale;
    const damage = baseDamage * (isSelf ? (splash.selfDamageScale ?? 1) : 1) * rules.damageScale;

    const baseKnock = (splash.minKnockback ?? 0) +
      ((splash.knockback ?? 0) - (splash.minKnockback ?? 0)) * falloff;
    const knock = baseKnock * (isSelf ? (splash.selfKnockbackScale ?? 1) : 1) * rules.knockbackScale;

    sub(tmpDir, tmpCenter, point);
    tmpDir.y += (splash.upBias ?? 0) * splash.radius;
    if (length(tmpDir) < 1e-4) set(tmpDir, 0, 1, 0);
    normalize(tmpDir, tmpDir);
    applyImpulse(actor, tmpDir, knock);

    // "Explosions heal" turns the blast into a medpack and keeps the shove,
    // which is what makes it a buff worth having rather than a disabled gun.
    if (rules.explosionsHeal) {
      const healed = Math.min(actor.maxHealth - actor.health, Math.round(damage));
      if (healed > 0) {
        actor.health += healed;
        world.events.emit('heal', {
          actor: actor.id, amount: healed, source: owner ?? null, weapon: weapon.id,
        });
      }
      results.push({ actor: actor.id, damage: -healed, knock, killed: false, self: isSelf });
      continue;
    }

    const outcome = applyDamage(world, actor, damage, {
      attacker: owner,
      weapon: weapon.id,
      point,
      cause: isSelf ? 'self' : cause,
    });
    results.push({ actor: actor.id, damage, knock, killed: outcome.killed, self: isSelf });
  }

  // A blast flattens what people left lying about, too. Without this a
  // grenade could not clear a turret, which is the obvious thing to try.
  for (const item of world.deployables?.items ?? []) {
    const dist = Math.hypot(
      item.pos.x - point.x, item.pos.y - point.y, item.pos.z - point.z,
    );
    if (dist > splash.radius) continue;
    const falloff = 1 - clamp(dist / splash.radius, 0, 1);
    const amount = (splash.minDamage + (splash.damage - splash.minDamage) * falloff)
      * damageScale * rules.damageScale;
    world.deployables.damage(item, amount, owner ?? null);
  }

  world.events.emit('explosion', {
    point,
    radius: splash.radius,
    weapon: weapon.id,
    owner: owner ?? null,
  });
  return results;
}
