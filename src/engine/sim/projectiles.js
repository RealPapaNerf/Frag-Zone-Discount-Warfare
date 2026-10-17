import { v3, clone, copy, set, sub, normalize, addScaled, scale, dot, length } from '../math/vec3.js';
import { traceActors } from './trace.js';
import { explode, applyDamage } from './damage.js';
import { applyImpulse } from './movement.js';

/**
 * Projectiles are simulated by the host, not by the shooter. Hitscan can be
 * trusted to the shooter because the shot is instant; a travelling rocket has
 * to agree for everyone, so this runs in one place.
 *
 * A projectile carries a velocity vector rather than a direction and a speed,
 * because a bouncing grenade's direction changes on every surface it touches
 * and there is no honest way to express that as "forward, plus some fall".
 *
 * Three optional behaviours, all from the weapon's `projectile` block:
 *   `bounce` — reflect off walls instead of detonating
 *   `fuseSec` — a timer that starts on spawn, not on impact
 *   `stick`  — stop dead where it lands, including on a player
 * A projectile with none of them detonates on impact, which is what a rocket
 * has always done.
 */

const REST_SPEED = 1.1;   // below this after a bounce, it stops rolling
const SKIN = 0.012;       // how far off a surface a bounce or a stick sits

export class ProjectileSystem {
  constructor(world) {
    this.world = world;
    this.projectiles = [];
    this.nextId = 1;
  }

  spawn({ owner, weaponId, origin, dir, speedScale = 1, damageScale = 1 }) {
    const weapon = this.world.weaponById(weaponId);
    const def = weapon.projectile;
    const speed = def.speed * speedScale;
    const heading = normalize(v3(), dir);
    // A fuse arms on spawn and is what kills the projectile; without one,
    // `lifetime` is the only clock and expiry still detonates.
    const life = def.fuseSec ?? def.lifetime ?? 6;
    const p = {
      id: this.nextId++,
      owner,
      weaponId,
      pos: clone(origin),
      prevPos: clone(origin),
      vel: scale(v3(), heading, speed),
      // Kept separately so a resting grenade still has a sane orientation to
      // be drawn with.
      dir: heading,
      damageScale,
      radius: def.radius ?? 0.2,
      gravityScale: def.gravityScale ?? 0,
      bounce: def.bounce ?? null,
      bouncesLeft: def.bounce?.maxBounces ?? 0,
      stick: !!def.stick,
      // Impact detonation is the default only for something that has no other
      // way to end: a grenade that bounces or sticks is waiting for its fuse.
      detonateOnImpact: def.detonateOnImpact ?? !(def.bounce || def.stick),
      stuckTo: null,      // actor id, when stuck to a player
      stuckOffset: null,
      resting: false,
      dieAt: this.world.time + life,
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
      copy(p.prevPos, p.pos);

      // A stuck grenade rides its victim until the fuse runs out.
      if (p.stuckTo != null) {
        const host = world.actorById(p.stuckTo);
        if (host) {
          set(p.pos, host.position.x + p.stuckOffset.x,
            host.position.y + p.stuckOffset.y,
            host.position.z + p.stuckOffset.z);
        } else {
          // Whoever it was stuck to left the match; leave it where it was.
          p.stuckTo = null;
          p.resting = true;
        }
        if (world.time >= p.dieAt) { this.#detonate(p, { kind: 'fuse', point: clone(p.pos) }); continue; }
        survivors.push(p);
        continue;
      }

      if (p.resting) {
        if (world.time >= p.dieAt) { this.#detonate(p, { kind: 'fuse', point: clone(p.pos) }); continue; }
        survivors.push(p);
        continue;
      }

      if (p.gravityScale) {
        p.vel.y += world.arena.gravity * p.gravityScale * world.rules.gravityScale * dt;
      }

      // One tick of travel, as a direction and a distance.
      const step = scale(v3(), p.vel, dt);
      let travel = length(step);
      if (travel < 1e-9) {
        if (world.time >= p.dieAt) { this.#detonate(p, { kind: 'fuse', point: clone(p.pos) }); continue; }
        survivors.push(p);
        continue;
      }
      const dir = normalize(v3(), step);
      copy(p.dir, dir);

      const hit = this.#trace(p, dir, travel);
      if (hit) {
        if (p.detonateOnImpact) {
          copy(p.pos, hit.point);
          this.#detonate(p, hit);
          continue;
        }
        if (p.stick) {
          this.#stickTo(p, hit);
          survivors.push(p);
          continue;
        }
        if (p.bounce && p.bouncesLeft > 0) {
          this.#reflect(p, hit);
          p.bouncesLeft -= 1;
          world.events.emit('projectileBounce', {
            id: p.id, weaponId: p.weaponId, pos: clone(p.pos),
            normal: hit.normal ? clone(hit.normal) : null,
          });
        } else {
          // Out of bounces and nothing else to do with it.
          copy(p.pos, hit.point);
          this.#detonate(p, hit);
          continue;
        }
      } else {
        addScaled(p.pos, p.pos, dir, travel);
      }

      if (world.time >= p.dieAt) {
        this.#detonate(p, { kind: 'fuse', point: clone(p.pos) });
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
    // A grenade that has already bounced is fair game against its thrower,
    // which is what makes bouncing one back at yourself your own fault.
    const ignore = p.bounce && p.bouncesLeft < (p.bounce.maxBounces ?? 0) ? null : p.owner;
    const actorHit = traceActors(world.actors, p.pos, dir, limit, ignore);
    if (actorHit) {
      return {
        kind: 'actor', point: actorHit.point, actor: actorHit.actor,
        headshot: actorHit.headshot, t: actorHit.t, normal: null,
      };
    }
    if (worldHit) {
      return { kind: 'world', point: worldHit.point, normal: worldHit.normal, t: worldHit.t };
    }
    return null;
  }

  /**
   * Reflect off a surface: the normal component flips and loses `restitution`,
   * the tangential component keeps `friction`. Below a walking pace it stops
   * rolling and just lies there waiting for the fuse.
   */
  #reflect(p, hit) {
    const normal = hit.normal
      // An actor has no surface normal, so bounce off the way we came in,
      // flattened, which reads as the grenade clattering off a shin.
      ?? normalize(v3(), set(v3(), -p.dir.x, 0.35, -p.dir.z));
    const spec = p.bounce;

    const along = dot(p.vel, normal);
    const vn = scale(v3(), normal, along);
    const vt = sub(v3(), p.vel, vn);
    scale(vt, vt, spec.friction ?? 0.7);
    scale(vn, vn, -(spec.restitution ?? 0.4));
    set(p.vel, vt.x + vn.x, vt.y + vn.y, vt.z + vn.z);

    // Sit just off the surface so the next trace does not start inside it.
    set(p.pos,
      hit.point.x + normal.x * (p.radius + SKIN),
      hit.point.y + normal.y * (p.radius + SKIN),
      hit.point.z + normal.z * (p.radius + SKIN));

    if (length(p.vel) < REST_SPEED) {
      set(p.vel, 0, 0, 0);
      p.resting = true;
    }
  }

  #stickTo(p, hit) {
    if (hit.kind === 'actor') {
      p.stuckTo = hit.actor.id;
      p.stuckOffset = sub(v3(), hit.point, hit.actor.position);
      set(p.vel, 0, 0, 0);
      this.world.events.emit('projectileStick', {
        id: p.id, weaponId: p.weaponId, pos: clone(hit.point), target: hit.actor.id,
      });
      copy(p.pos, hit.point);
      return;
    }
    const normal = hit.normal ?? v3(0, 1, 0);
    set(p.pos,
      hit.point.x + normal.x * SKIN,
      hit.point.y + normal.y * SKIN,
      hit.point.z + normal.z * SKIN);
    set(p.vel, 0, 0, 0);
    p.resting = true;
    this.world.events.emit('projectileStick', {
      id: p.id, weaponId: p.weaponId, pos: clone(p.pos), target: null,
    });
  }

  #detonate(p, hit) {
    const world = this.world;
    const weapon = world.weaponById(p.weaponId);

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
      // The renderer draws a stuck or resting grenade differently from one in
      // flight — no thruster trail on something lying on the floor.
      resting: p.resting || p.stuckTo != null,
    }));
  }
}
