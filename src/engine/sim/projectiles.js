import { v3, clone, copy, set, sub, normalize, addScaled, scale, dot, cross, length } from '../math/vec3.js';
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
 * Five optional behaviours, all from the weapon's `projectile` block:
 *   `bounce`    — reflect off walls instead of detonating
 *   `fuseSec`   — a timer that starts on spawn, not on impact
 *   `stick`     — stop dead where it lands, including on a player
 *   `cluster`   — spawn more projectiles when this one goes off
 *   `boomerang` — curve continuously instead of flying straight
 * A projectile with none of them detonates on impact, which is what a rocket
 * has always done.
 *
 * `cluster` is the recursion rule, and it is deliberately general rather than
 * a cluster bomb: a projectile spawns `count` more, of any weapon including
 * its own, each one generation shallower. A weapon that clusters into itself
 * is the "tier-N fires tier-(N-1)" shape the stapler ladder and the mulcher
 * cannon both want, so it is written once here and not three times later.
 * `generations` is the budget, carried on the projectile and spent on the way
 * down, which is what stops it being a fork bomb.
 */

const REST_SPEED = 1.1;   // below this after a bounce, it stops rolling
const SKIN = 0.012;       // how far off a surface a bounce or a stick sits
const MAX_GENERATIONS = 3;
const MAX_CHILDREN = 8;
// A hard ceiling on live projectiles. Recursion plus several shooters can
// multiply faster than any per-weapon limit predicts, and a dropped bomblet
// is a better failure than a stalled tick.
const MAX_PROJECTILES = 160;

export class ProjectileSystem {
  constructor(world) {
    this.world = world;
    this.projectiles = [];
    this.nextId = 1;
  }

  spawn({ owner, weaponId, origin, dir, speedScale = 1, damageScale = 1,
    generations = null, ignoreOwner = true }) {
    if (this.projectiles.length >= MAX_PROJECTILES) return null;
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
      boomerang: def.boomerang?.turnRateDeg ? def.boomerang : null,
      turned: 0,          // radians of curve flown so far
      stuckTo: null,      // actor id, when stuck to a player
      stuckOffset: null,
      resting: false,
      // A projectile that left your own muzzle cannot hit you directly; one
      // that bounced off a wall or was thrown out of a cluster can.
      ignoreOwner,
      generations: Math.max(0, Math.min(MAX_GENERATIONS,
        generations ?? def.cluster?.generations ?? 0)),
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

      if (p.boomerang) this.#curve(p, dt);

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
        // `hitActors` separates "bounces off the scenery" from "bounces off
        // people". A frag grenade should clatter off a shin; a boomerang that
        // bounced off the person it caught would never hit anybody at all.
        const bounceOffThis = p.bounce && p.bouncesLeft > 0
          && !(hit.kind === 'actor' && p.bounce.hitActors);
        if (bounceOffThis) {
          this.#reflect(p, hit);
          p.bouncesLeft -= 1;
          p.ignoreOwner = false;
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
    // The owner is never a direct-hit target while the projectile is still
    // the one that left their muzzle; self-damage reaches them through the
    // splash pass instead. Once it has bounced, or been thrown out of a
    // cluster, it is fair game — which is what makes catching your own
    // grenade off a wall your own fault.
    const actorHit = traceActors(world.actors, p.pos, dir, limit, p.ignoreOwner ? p.owner : null);
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
   * Bend the flight path. The turn is applied around the vertical axis at a
   * constant rate, which traces a circle of radius speed / turnRate — so a
   * fast axe draws a wide loop and a slow one orbits your head.
   *
   * Half a turn in, the thrower stops being immune to it. A boomerang that
   * came back round and could not hit the person who threw it would be
   * missing the only joke it has.
   */
  #curve(p, dt) {
    const rate = (p.boomerang.turnRateDeg ?? 0) * (Math.PI / 180) * dt;
    if (!rate) return;
    const cos = Math.cos(rate);
    const sin = Math.sin(rate);
    const { x, z } = p.vel;
    p.vel.x = x * cos - z * sin;
    p.vel.z = x * sin + z * cos;

    p.turned += Math.abs(rate);
    if (p.turned > Math.PI / 2) p.ignoreOwner = false;
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
    const cluster = weapon.projectile?.cluster ?? null;
    const spawning = cluster && p.generations > 0;
    // A clustering projectile may hand all its damage to its children rather
    // than doing any itself, which is what "it launches and *then* explodes"
    // means: the thing you threw is a delivery mechanism.
    const parentDetonates = spawning ? (cluster.detonateParent ?? true) : true;

    if (spawning) this.#spawnCluster(p, hit, cluster);

    if (hit.kind === 'actor' && parentDetonates) {
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
      world.applyOnHit(weapon, p.owner, hit.actor);
    }

    if (weapon.splash && parentDetonates) {
      const caught = explode(world, {
        point: hit.point, weapon, owner: p.owner, damageScale: p.damageScale ?? 1,
      });
      // Anything the blast reached also catches whatever the weapon applies.
      for (const result of caught) {
        const victim = world.actorById(result.actor);
        if (victim) world.applyOnHit(weapon, p.owner, victim);
      }
    }

    world.events.emit('projectileEnd', {
      id: p.id,
      pos: clone(hit.point ?? p.pos),
      normal: hit.normal ?? null,
      weaponId: p.weaponId,
      hit: hit.kind,
    });
  }

  /**
   * Throw the next generation out of a detonation. Children start just off the
   * surface so they do not immediately collide with the thing their parent
   * just hit, and they carry one less generation than their parent had.
   */
  #spawnCluster(p, hit, cluster) {
    const world = this.world;
    const rng = world.rng;
    const count = Math.max(1, Math.min(MAX_CHILDREN, Math.round(cluster.count ?? 1)));
    const normal = hit.normal ?? v3(0, 1, 0);
    const childId = cluster.weapon ?? p.weaponId;
    if (!world.weaponById(childId)) return;

    const origin = v3(
      hit.point.x + normal.x * (p.radius + SKIN * 4),
      hit.point.y + normal.y * (p.radius + SKIN * 4),
      hit.point.z + normal.z * (p.radius + SKIN * 4),
    );

    for (let i = 0; i < count; i++) {
      const dir = this.#clusterDir(p, normal, cluster, rng);
      const child = this.spawn({
        owner: p.owner,
        weaponId: childId,
        origin: clone(origin),
        dir,
        speedScale: cluster.speedScale ?? 1,
        damageScale: p.damageScale ?? 1,
        generations: p.generations - 1,
        // It did not come out of their muzzle, so it can hit them.
        ignoreOwner: false,
      });
      if (!child) break; // hit the ceiling; drop the rest
    }
    world.events.emit('projectileCluster', {
      id: p.id, weaponId: p.weaponId, child: childId,
      pos: clone(hit.point), count,
    });
  }

  #clusterDir(p, normal, cluster, rng) {
    const mode = cluster.direction ?? 'random';
    let base;
    if (mode === 'forward') {
      base = clone(p.dir);
    } else if (mode === 'reflect') {
      const along = dot(p.dir, normal);
      base = normalize(v3(), v3(
        p.dir.x - 2 * along * normal.x,
        p.dir.y - 2 * along * normal.y,
        p.dir.z - 2 * along * normal.z,
      ));
    } else {
      // Random, but out of the surface rather than into it. A bomblet that
      // buries itself in the floor it just landed on is not a surprise, it
      // is a dud.
      base = randomUnit(rng);
      if (dot(base, normal) < 0) scale(base, base, -1);
    }
    const spread = cluster.spreadDeg ?? 0;
    if (spread <= 0) return base;
    const off = rng.coneOffset((spread * 0.5) * Math.PI / 180);
    const up = Math.abs(base.y) > 0.99 ? v3(0, 0, 1) : v3(0, 1, 0);
    const right = normalize(v3(), cross(v3(), base, up));
    const trueUp = cross(v3(), right, base);
    return normalize(v3(), v3(
      base.x + right.x * off.x + trueUp.x * off.y,
      base.y + right.y * off.x + trueUp.y * off.y,
      base.z + right.z * off.x + trueUp.z * off.y,
    ));
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

/** A uniform direction on the sphere, from the world's seeded RNG. */
function randomUnit(rng) {
  // Sampled from z and an angle so the distribution is even over the sphere
  // rather than bunched at the poles.
  const z = rng.range(-1, 1);
  const theta = rng.range(0, Math.PI * 2);
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  return v3(Math.cos(theta) * r, z, Math.sin(theta) * r);
}
