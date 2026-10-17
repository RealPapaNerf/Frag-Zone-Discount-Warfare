import { v3, clone, set, sub, normalize, distanceSq, length } from '../math/vec3.js';
import { applyDamage, explode } from './damage.js';
import { applyImpulse } from './movement.js';

/**
 * Things you leave on the floor.
 *
 * A deployable is placed, spends a moment arming, then sits there until its
 * lifetime runs out, something walks into it, or somebody shoots it. That one
 * shape covers most of what the weapon list wants out of a placed object: a
 * grill that flattens whoever steps on it, a wet floor sign that is a hazard
 * rather than a weapon, a claymore, and a turret that picks its own targets.
 *
 * The arming delay is the important bit of game design in here. Without it,
 * dropping a trap under someone's feet is the same as shooting them, and
 * every trap weapon collapses into a bad shotgun.
 */

const MAX_DEPLOYABLES = 48;

export class DeployableSystem {
  constructor(world) {
    this.world = world;
    this.items = [];
    this.nextId = 1;
  }

  byId(id) {
    return this.items.find((d) => d.id === id) ?? null;
  }

  ownedBy(ownerId, defId = null) {
    return this.items.filter((d) => d.owner === ownerId && (!defId || d.defId === defId));
  }

  /**
   * Put one down. Returns the deployable, or null if it could not be placed.
   * Going over a placer's allowance removes their oldest rather than refusing
   * the new one — a trap you cannot place because of a trap you forgot about
   * is a confusing failure.
   */
  place({ owner, deployableId, pos, yaw = 0 }) {
    const def = this.world.content.deployables?.[deployableId];
    if (!def) return null;
    if (this.items.length >= MAX_DEPLOYABLES) return null;

    // Per deployable *type*, not per player. Counting everything someone owns
    // would mean putting down a turret with an allowance of one quietly binned
    // the grill they left in the next room.
    const allowance = Math.max(1, def.maxActive ?? 1);
    const mine = this.ownedBy(owner, deployableId);
    if (mine.length >= allowance) this.#remove(mine[0], 'replaced');

    const now = this.world.time;
    const item = {
      id: this.nextId++,
      defId: deployableId,
      def,
      owner,
      pos: clone(pos),
      yaw,
      health: def.health ?? 1,
      maxHealth: def.health ?? 1,
      armedAt: now + Math.max(0, def.armTimeSec ?? 0),
      dieAt: now + (def.lifetimeSec ?? 60),
      nextFireAt: 0,
      spent: false,
    };
    this.items.push(item);
    this.world.events.emit('deployablePlaced', {
      id: item.id, defId: deployableId, owner, pos: clone(pos), yaw,
      armsAt: item.armedAt,
    });
    return item;
  }

  step(dt) {
    const world = this.world;
    const survivors = [];

    for (const item of this.items) {
      if (item.spent) continue;
      if (world.time >= item.dieAt) {
        this.#remove(item, 'expired');
        continue;
      }
      if (world.time >= item.armedAt) {
        const kind = item.def.trigger?.type ?? 'none';
        if (kind === 'proximity') this.#stepProximity(item);
        else if (kind === 'turret') this.#stepTurret(item, dt);
      }
      if (!item.spent) survivors.push(item);
    }
    this.items = survivors;
  }

  /** Anything in range sets it off. */
  #stepProximity(item) {
    const trigger = item.def.trigger;
    // A repeating trap owes its cooldown. Without this check it sets the
    // timer and then ignores it, firing sixty times a second at anyone
    // standing on it.
    if (this.world.time < item.nextFireAt) return;

    const radiusSq = (trigger.radiusM ?? 1.5) ** 2;
    const caught = [];

    for (const actor of this.world.actors) {
      if (!actor.alive) continue;
      if (actor.id === item.owner && trigger.affectsOwner === false) continue;
      if (distanceSq(actor.position, item.pos) > radiusSq) continue;
      caught.push(actor);
    }
    if (caught.length === 0) return;

    this.#fireTrigger(item, caught);
    if (trigger.oneShot !== false) this.#remove(item, 'triggered');
    else item.nextFireAt = this.world.time + (trigger.cooldownSec ?? 1);
  }

  /** Picks its own target and shoots it, on a timer. */
  #stepTurret(item, _dt) {
    const world = this.world;
    const trigger = item.def.trigger;
    if (world.time < item.nextFireAt) return;

    const range = trigger.rangeM ?? 20;
    const rangeSq = range * range;
    const muzzle = v3(item.pos.x, item.pos.y + (item.def.muzzleHeight ?? 0.5), item.pos.z);

    let best = null;
    let bestDistSq = Infinity;
    for (const actor of world.actors) {
      if (!actor.alive) continue;
      if (actor.id === item.owner && trigger.affectsOwner === false) continue;
      const distSq = distanceSq(actor.position, item.pos);
      if (distSq > rangeSq || distSq >= bestDistSq) continue;
      const centre = actor.center(v3());
      if (!world.arena.lineOfSight(muzzle, centre)) continue;
      best = actor;
      bestDistSq = distSq;
    }
    if (!best) return;

    item.nextFireAt = world.time + Math.max(0.05, trigger.intervalSec ?? 1);
    const dir = normalize(v3(), sub(v3(), best.center(v3()), muzzle));
    item.yaw = Math.atan2(-dir.x, -dir.z);

    const weaponId = item.def.turret?.weapon;
    const weapon = weaponId ? world.weaponById(weaponId) : null;
    if (!weapon?.projectile) return;
    world.projectiles.spawn({
      owner: item.owner,
      weaponId,
      origin: muzzle,
      dir,
      // It did not come out of anybody's muzzle, so it can hit its placer.
      ignoreOwner: false,
    });
    world.events.emit('deployableFired', {
      id: item.id, defId: item.defId, owner: item.owner, pos: clone(muzzle), target: best.id,
    });
  }

  /** What going off actually does to the people it caught. */
  #fireTrigger(item, caught) {
    const world = this.world;
    const effect = item.def.onTrigger ?? {};

    world.events.emit('deployableTriggered', {
      id: item.id, defId: item.defId, owner: item.owner, pos: clone(item.pos),
      caught: caught.map((a) => a.id),
    });

    if (effect.splash) {
      // Reuse the blast path so cover and falloff behave as they do elsewhere.
      explode(world, {
        point: clone(item.pos),
        weapon: { id: item.defId, splash: effect.splash },
        owner: item.owner,
        cause: 'trap',
      });
    }

    for (const actor of caught) {
      if (effect.knockback) {
        const away = sub(v3(), actor.center(v3()), item.pos);
        away.y += (effect.upBias ?? 0.6) * 2;
        if (length(away) < 1e-4) set(away, 0, 1, 0);
        normalize(away, away);
        applyImpulse(actor, away, effect.knockback * world.rules.knockbackScale);
      }
      if (effect.damage) {
        applyDamage(world, actor, effect.damage * world.rules.damageScale, {
          attacker: item.owner,
          weapon: item.defId,
          point: clone(item.pos),
          cause: 'trap',
        });
      }
      // "Run over influence radius: fall, drop weapon." All of it, not one.
      if (effect.dropItems) {
        world.pickups.dropLoadout(actor, { ownerDelaySec: effect.dropGraceSec ?? 3 });
      }
      for (const entry of effect.effects ?? []) {
        world.applyEffect(actor, entry.effect, {
          source: item.owner,
          stacks: entry.stacks ?? 1,
          data: { deployable: item.defId },
        });
      }
    }
  }

  /** Shoot the thing. @returns {boolean} whether it was destroyed */
  damage(item, amount, attacker = null) {
    if (!item || item.spent) return false;
    item.health -= amount;
    this.world.events.emit('deployableDamaged', {
      id: item.id, defId: item.defId, remaining: Math.max(0, item.health), attacker,
    });
    if (item.health > 0) return false;
    // A trap destroyed by gunfire still goes off if it was built to.
    if (item.def.detonateWhenDestroyed && this.world.time >= item.armedAt) {
      this.#fireTrigger(item, []);
    }
    this.#remove(item, 'destroyed', attacker);
    return true;
  }

  #remove(item, reason, attacker = null) {
    if (item.spent) return;
    item.spent = true;
    this.items = this.items.filter((d) => d !== item);
    this.world.events.emit('deployableRemoved', {
      id: item.id, defId: item.defId, owner: item.owner,
      pos: clone(item.pos), reason, attacker,
    });
  }

  /** Drop everything a departing player left behind. */
  removeAllOwnedBy(ownerId) {
    for (const item of this.ownedBy(ownerId)) this.#remove(item, 'ownerLeft');
  }

  snapshot() {
    return this.items.map((d) => ({
      id: d.id,
      defId: d.defId,
      owner: d.owner,
      pos: clone(d.pos),
      yaw: d.yaw,
      health: d.health,
      maxHealth: d.maxHealth,
      armed: this.world.time >= d.armedAt,
    }));
  }
}
