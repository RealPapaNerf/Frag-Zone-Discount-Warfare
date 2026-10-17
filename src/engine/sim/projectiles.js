import { v3, clone, normalize, addScaled, length } from '../math/vec3.js';
import { traceActors } from './trace.js';
import { explode, applyDamage } from './damage.js';
import { applyImpulse } from './movement.js';

/**
 * Projectiles are simulated by the host, not by the shooter. Hitscan can be
 * trusted to the shooter because the shot is instant; a travelling rocket has
 * to agree for everyone, so this runs in one place.
 */
export class ProjectileSystem {
  constructor(world) {
    this.world = world;
    this.projectiles = [];
    this.nextId = 1;
  }

  spawn({ owner, weaponId, origin, dir, speedScale = 1, damageScale = 1 }) {
    const weapon = this.world.content.weapons[weaponId];
    const def = weapon.projectile;
    const p = {
      id: this.nextId++,
      owner,
      weaponId,
      pos: clone(origin),
      prevPos: clone(origin),
      dir: normalize(v3(), dir),
      // A charged shot travels faster and hits harder; both ride along on the
      // projectile because the host, not the shooter, simulates the flight.
      speed: def.speed * speedScale,
      damageScale,
      radius: def.radius ?? 0.2,
      gravityScale: def.gravityScale ?? 0,
      velY: 0,
      dieAt: this.world.time + (def.lifetime ?? 6),
    };
    this.projectiles.push(p);
    this.world.events.emit('projectileSpawn', {
      id: p.id, owner, weaponId, pos: clone(p.pos), dir: clone(p.dir),
    });
    return p;
  }

  step(dt) {
    const world = this.world;
    const survivors = [];

    for (const p of this.projectiles) {
      p.prevPos.x = p.pos.x; p.prevPos.y = p.pos.y; p.prevPos.z = p.pos.z;

      // Build this tick's travel vector, including any projectile gravity.
      const step = v3(p.dir.x * p.speed * dt, p.dir.y * p.speed * dt, p.dir.z * p.speed * dt);
      if (p.gravityScale) {
        p.velY += world.arena.gravity * p.gravityScale * world.rules.gravityScale * dt;
        step.y += p.velY * dt;
      }
      const travel = length(step);
      const dir = normalize(v3(), step);

      const hit = this.#trace(p, dir, travel);
      if (hit) {
        p.pos.x = hit.point.x; p.pos.y = hit.point.y; p.pos.z = hit.point.z;
        this.#detonate(p, hit);
        continue;
      }

      addScaled(p.pos, p.pos, dir, travel);
      if (world.time >= p.dieAt) {
        this.#detonate(p, { kind: 'expire', point: clone(p.pos) });
        continue;
      }
      survivors.push(p);
    }
    this.projectiles = survivors;
  }

  #trace(p, dir, travel) {
    const world = this.world;
    const worldHit = world.arena.raycast(p.pos, dir, travel, p.radius);
    const limit = worldHit ? worldHit.t : travel;
    // The owner is never a direct-hit target: a rocket spawns inside their own
    // hitbox. Self-damage still reaches them through the splash pass.
    const actorHit = traceActors(world.actors, p.pos, dir, limit, p.owner);
    if (actorHit) return { kind: 'actor', point: actorHit.point, actor: actorHit.actor, headshot: actorHit.headshot, t: actorHit.t };
    if (worldHit) return { kind: 'world', point: worldHit.point, normal: worldHit.normal, t: worldHit.t };
    return null;
  }

  #detonate(p, hit) {
    const world = this.world;
    const weapon = world.content.weapons[p.weaponId];

    if (hit.kind === 'actor') {
      const fire = weapon.fire;
      const direct = fire.damage * (p.damageScale ?? 1) * world.rules.damageScale;
      applyImpulse(hit.actor, p.dir, (fire.knockback ?? 0) * world.rules.knockbackScale);
      applyDamage(world, hit.actor, direct, {
        attacker: p.owner,
        weapon: p.weaponId,
        point: hit.point,
        headshot: false,
        cause: 'direct',
      });
    }

    if (weapon.splash) {
      explode(world, {
        point: hit.point, weapon, owner: p.owner, damageScale: p.damageScale ?? 1,
      });
    }

    world.events.emit('projectileEnd', {
      id: p.id,
      pos: clone(hit.point ?? p.pos),
      normal: hit.normal ?? null,
      weaponId: p.weaponId,
      hit: hit.kind,
    });
  }

  snapshot() {
    return this.projectiles.map((p) => ({
      id: p.id, owner: p.owner, weaponId: p.weaponId, pos: clone(p.pos), dir: clone(p.dir),
    }));
  }
}
